/**
 * YouTube 要約ツール - Cloudflare Workers エントリポイント
 *
 * 静的アセット (public/) は Cloudflare 側が先に処理するため、
 * この Worker には API へのリクエストだけが届く。
 */

import { extractVideoId, fetchTranscript, TranscriptError } from './youtube.js';
import { summarize, LENGTH_PRESETS } from './summarize.js';
import {
  geminiAvailable,
  startGeminiJob,
  getGeminiJob,
  fetchVideoInfo,
  GeminiError,
  DEFAULT_GEMINI_MODEL,
} from './gemini.js';

/** 1リクエストで受け付ける本文の最大サイズ */
const MAX_BODY_BYTES = 8192;
/** Gemini の検証依頼は下書きを載せるので大きめに取る */
const MAX_GEMINI_BODY_BYTES = 128 * 1024;

/**
 * 一度に処理できる動画の数の既定値。
 *
 * Workers の無料プランは 1 リクエストあたりのサブリクエストが 50 件まで。
 * 1本の動画で、字幕取得 (最大8経路 + 字幕本体) と AI 呼び出し (要約 + 検証、
 * 長い動画では分割数だけ追加) を使うため、本数を増やしすぎると上限に当たる。
 * 有料プランなら 1,000 件まで使えるので、wrangler.jsonc の MAX_URLS で増やせる。
 */
const DEFAULT_MAX_URLS = 5;

/**
 * 使えるエンジンを列挙する。
 *
 * gemini      : Gemini に YouTube の URL を渡し、音声と映像の両方を解析させる。
 *               API キーが要るが、bot 判定を受けず、画面の文字も読める。
 * workers-ai  : 字幕を取得して Workers AI で要約する。キー不要だが上記の弱点がある。
 */
function availableEngines(env) {
  const engines = [];
  if (geminiAvailable(env)) engines.push('gemini');
  engines.push('workers-ai');
  return engines;
}

/** 設定と要求から、実際に使うエンジンを決める */
function resolveEngine(env, requested) {
  const available = availableEngines(env);
  const configured = env.ENGINE || 'auto';

  // 明示的に指定された場合は、使える範囲でそれに従う
  for (const candidate of [requested, configured]) {
    if (candidate && candidate !== 'auto' && available.includes(candidate)) return candidate;
  }
  // auto は使えるもののうち先頭 (gemini があれば gemini)
  return available[0];
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/health') {
      return json({
        ok: true,
        engines: availableEngines(env),
        defaultEngine: resolveEngine(env, null),
        // auto のときだけ、Gemini が失敗したら画面が字幕経路に切り替える
        engineMode: env.ENGINE || 'auto',
        model: env.SUMMARY_MODEL ?? null,
        geminiModel: geminiAvailable(env) ? (env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL) : null,
        preferredLangs: env.PREFERRED_LANGS ?? null,
        maxUrls: maxUrls(env),
      });
    }

    if (url.pathname === '/api/summarize') {
      if (request.method !== 'POST') {
        return json({ error: 'POST を使用してください' }, 405);
      }
      return handleSummarize(request, env);
    }

    if (url.pathname === '/api/gemini/start') {
      if (request.method !== 'POST') {
        return json({ error: 'POST を使用してください' }, 405);
      }
      return handleGeminiStart(request, env);
    }

    if (url.pathname === '/api/gemini/status') {
      return handleGeminiStatus(url, env);
    }

    return json({ error: 'Not Found' }, 404);
  },
};

function maxUrls(env) {
  const n = Number(env.MAX_URLS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_MAX_URLS;
}

/**
 * 入力から動画の一覧を作る。
 * 同じ動画が複数回指定された場合は最初の1件だけ残す。
 */
function collectVideos(body, limit) {
  const raw = Array.isArray(body?.urls) ? body.urls : [body?.url];

  const seen = new Set();
  const videos = [];
  const invalid = [];

  for (const entry of raw) {
    if (typeof entry !== 'string' || !entry.trim()) continue;

    const input = entry.trim();
    const videoId = extractVideoId(input);

    if (!videoId) {
      invalid.push(input);
      continue;
    }
    if (seen.has(videoId)) continue;

    seen.add(videoId);
    videos.push({ input, videoId });
    if (videos.length >= limit) break;
  }

  return { videos, invalid, truncated: videos.length >= limit };
}

async function handleSummarize(request, env) {
  // --- 入力の検証 ---
  const contentLength = Number(request.headers.get('content-length') ?? 0);
  if (contentLength > MAX_BODY_BYTES) {
    return json({ error: 'リクエストが大きすぎます' }, 413);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'リクエストの形式が不正です' }, 400);
  }

  const limit = maxUrls(env);
  const { videos, invalid, truncated } = collectVideos(body, limit);

  if (!videos.length) {
    return json(
      {
        error: invalid.length
          ? 'YouTube の URL として認識できませんでした。動画ページの URL を貼り付けてください。'
          : 'URL を入力してください。',
        invalid,
      },
      400,
    );
  }

  const length = Object.hasOwn(LENGTH_PRESETS, body?.length) ? body.length : 'standard';
  // 検証パスはモデルをもう一度呼ぶため、明示的に false のときだけ省略する
  const review = body?.review !== false;
  const preferredLangs = (env.PREFERRED_LANGS ?? 'ja,en')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  // --- SSE でストリーミング返却 ---
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (event, data) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };

      let succeeded = 0;
      let failed = 0;

      try {
        send('queue', {
          items: videos.map((v, index) => ({ index, videoId: v.videoId, input: v.input })),
          invalid,
          truncated,
          limit,
          engine: 'workers-ai',
        });

        // 1本ずつ順に処理する。並行にすると YouTube 側の制限に当たりやすく、
        // サブリクエストの上限にも近づくため。
        for (const [index, video] of videos.entries()) {
          try {
            await summarizeOne(env, {
              video,
              index,
              total: videos.length,
              length,
              review,
              preferredLangs,
              send,
            });
            succeeded++;
          } catch (err) {
            failed++;
            console.error(`summarize failed for ${video.videoId}`, err);
            if (err instanceof TranscriptError || err instanceof GeminiError) {
              send('item-error', {
                index,
                code: err.code,
                message: err.message,
                detail: err.detail ?? null,
              });
            } else {
              send('item-error', {
                index,
                code: 'INTERNAL',
                message: `要約の生成に失敗しました: ${err?.message ?? '原因不明のエラー'}`,
              });
            }
          }
        }

        send('done', { total: videos.length, succeeded, failed });
      } catch (err) {
        // ループの外側で落ちた場合 (サブリクエスト上限など)
        console.error('batch failed', err);
        send('fatal', {
          message: `処理を続けられませんでした: ${err?.message ?? '原因不明のエラー'}`,
          succeeded,
          failed,
        });
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          /* すでに閉じている */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

/**
 * 1本の動画を字幕経路で処理し、進捗と本文を index つきで送る。
 *
 * Gemini 経路はここを通らない。Gemini は動画を読み終えるまで応答を返さず、
 * Cloudflare の約100秒の待ち時間の上限を超えるため、受付と問い合わせに
 * 分けた /api/gemini/* を画面側から呼ぶ。
 */
async function summarizeOne(env, params) {
  const position = params.total > 1 ? `(${params.index + 1}/${params.total}) ` : '';
  return runCaptionEngine(env, params, position);
}

/** 字幕を取得して Workers AI で要約する */
async function runCaptionEngine(env, { video, index, length, review, preferredLangs, send }, position) {
  send('status', { index, phase: 'fetching', message: `${position}字幕を取得中…` });

  const transcript = await fetchTranscript(video.videoId, { preferredLangs });

  send('meta', {
    index,
    videoId: video.videoId,
    title: transcript.metadata.title,
    author: transcript.metadata.author,
    lengthSeconds: transcript.metadata.lengthSeconds,
    captionLanguage: transcript.track.languageCode,
    captionIsAsr: transcript.track.isAsr,
    source: 'captions',
  });

  const result = await summarize(env, {
    segments: transcript.segments,
    metadata: transcript.metadata,
    length,
    review,
    onStatus: (s) => send('status', { ...s, index, message: `${position}${s.message ?? ''}` }),
    onDelta: (d) => send('delta', { index, text: d }),
    onReset: (text) => send('reset', { index, text: text ?? '' }),
  });

  send('item-done', {
    index,
    engine: 'workers-ai',
    chunks: result.chunks,
    sampled: result.sampled,
    model: result.model,
    reviewed: result.reviewed,
    reviewError: result.reviewError ?? null,
  });
}

/**
 * Gemini に要約 (または下書きの検証) を依頼し、受付番号を返す。
 * 依頼するだけなのですぐ終わる。
 */
async function handleGeminiStart(request, env) {
  if (!geminiAvailable(env)) {
    return json({ code: 'GEMINI_UNAVAILABLE', error: 'Gemini の API キーが設定されていません。' }, 400);
  }

  const contentLength = Number(request.headers.get('content-length') ?? 0);
  if (contentLength > MAX_GEMINI_BODY_BYTES) {
    return json({ error: 'リクエストが大きすぎます' }, 413);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'リクエストの形式が不正です' }, 400);
  }

  const videoId = extractVideoId(body?.url ?? '');
  if (!videoId) {
    return json({ code: 'BAD_URL', error: 'YouTube の URL として認識できませんでした。' }, 400);
  }

  const length = Object.hasOwn(LENGTH_PRESETS, body?.length) ? body.length : 'standard';
  const draft = typeof body?.draft === 'string' && body.draft.trim() ? body.draft : undefined;
  const resolution = body?.resolution === 'low' ? 'low' : undefined;

  try {
    // 題名は要約の依頼と並行して取る。取れなくても要約はできる
    const [job, info] = await Promise.all([
      startGeminiJob(env, { videoId, length, draft, resolution }),
      draft ? Promise.resolve(null) : fetchVideoInfo(videoId),
    ]);
    return json({ id: job.id, status: job.status, model: job.model, videoId, info });
  } catch (err) {
    return geminiErrorResponse(err);
  }
}

/** 依頼した処理の状態を返す。画面が数秒おきに呼ぶ */
async function handleGeminiStatus(url, env) {
  if (!geminiAvailable(env)) {
    return json({ code: 'GEMINI_UNAVAILABLE', error: 'Gemini の API キーが設定されていません。' }, 400);
  }
  try {
    return json(await getGeminiJob(env, url.searchParams.get('id') ?? ''));
  } catch (err) {
    return geminiErrorResponse(err);
  }
}

function geminiErrorResponse(err) {
  if (err instanceof GeminiError) {
    const status = err.code === 'GEMINI_BAD_REQUEST' ? 400 : 502;
    return json({ code: err.code, error: err.message }, status);
  }
  console.error('gemini request failed', err);
  return json({ code: 'INTERNAL', error: `Gemini の呼び出しに失敗しました: ${err?.message ?? '原因不明'}` }, 500);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
