/**
 * Gemini API を使って YouTube 動画を直接要約する。
 *
 * 字幕ベースの経路 (youtube.js + summarize.js) には3つの弱点がある。
 *   1. Cloudflare のIPからだと YouTube に bot 判定されることがある
 *   2. 字幕は音声しか拾えず、画面に表示された情報が落ちる
 *   3. 自動生成字幕は固有名詞を聞き間違える
 *
 * Gemini は YouTube の URL を渡すと Google 側が動画を取得し、
 * 音声と映像の両方を解析する。そのため3つとも起きない。
 *
 * ただし Gemini は動画を読み終えるまで応答を返し始めない。Cloudflare は
 * 外部への通信が約100秒応答を返さないと 524 で打ち切るため、ある程度の長さの
 * 動画では同期的に呼べない。そこで Interactions API のバックグラウンド実行を
 * 使う。依頼するとすぐ受付番号 (interaction id) が返り、処理は Google 側で
 * 続く。完了したかは受付番号で問い合わせる。どちらの通信も一瞬で終わる。
 *
 * 問い合わせの繰り返しは画面側が行う。Worker の中でループすると、無料プランの
 * 1リクエストあたり50件というサブリクエストの上限に当たるため。
 */

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';

/** Gemini を使える状態かどうか */
export function geminiAvailable(env) {
  return Boolean(env.GEMINI_API_KEY);
}

/** Gemini の呼び出しに失敗した理由を、利用者に説明できる形で持ち回す */
export class GeminiError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'GeminiError';
    this.code = code;
    this.detail = detail;
  }
}

export const GEMINI_PRESETS = {
  short: { bullets: '4〜6個', maxTokens: 2000, detail: false },
  standard: { bullets: '6〜9個', maxTokens: 4000, detail: true },
  detailed: { bullets: '8〜12個', maxTokens: 8000, detail: true },
};

/**
 * 動画の題名と投稿者を取得する。
 *
 * oEmbed は player API と違って認証も内部APIも使わないため、
 * bot 判定を受けにくい。取れなくても要約はできるので、失敗は無視する。
 */
export async function fetchVideoInfo(videoId) {
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(
        `https://www.youtube.com/watch?v=${videoId}`,
      )}&format=json`,
      { headers: { Accept: 'application/json' } },
    );
    if (!res.ok) return null;

    const data = await res.json();
    return { title: data.title ?? null, author: data.author_name ?? null };
  } catch {
    return null;
  }
}

/** 話題の目次ではなく中身を書かせ、かつ創作を防ぐための共通ルール */
const RULES = [
  '## 書き方のルール',
  '',
  '話題を示すだけの書き方は禁止です。必ず「何と言っていたか」「何が映っていたか」を書いてください。',
  '',
  '禁止する書き方の例:',
  '- レビュー機能の追加について話している',
  '- 価格戦略について比較している',
  '',
  '書くべき形の例:',
  '- レビュー依頼は購入直後ではなく、利用が定着した頃に送ると回答率が上がる',
  '- 買い切りは初期の売上が立ちやすいが継続収益にならないため、サブスクに切り替えた',
  '',
  '手順ややり方が説明されている場合は、その手順を番号付きで具体的に書いてください。',
  '数値・金額・ツール名・サービス名・設定値は、省略せずそのまま残してください。',
  '',
  '## 画面に映っている情報も読み取ってください',
  '',
  'この動画には、音声では説明されていない情報が画面に表示されていることがあります。',
  '- 画面に出ている URL・サービス名・ツール名は、表示されている綴りのまま正確に書き写す',
  '- 画面に出ているコード・設定値・数値・スライドの文言も拾う',
  '- 音声と画面で表記が食い違う場合は、画面の表記を採用する',
  '  (例: 音声では「デザインmd」と聞こえても、画面に getdesign.md と出ていればそちらを書く)',
  '',
  '## 絶対にやってはいけないこと',
  '',
  '- この動画に映っていない・語られていない情報を書き足す',
  '- あなた自身が持っている知識で説明を補う',
  '- 読み取れなかった文字を推測で埋める',
  '- 挨拶・チャンネル登録の依頼・広告・提供表示を要約に含める',
  '',
  '読み取れなかったものや判断に迷ったものは、推測せず「確認が必要な点」に書いてください。',
].join('\n');

/** 出力フォーマットの指定を組み立てる */
function outputFormat(preset) {
  const sections = [
    '## 出力フォーマット',
    '',
    '## ひとことで言うと',
    '（この動画で結局何が言われていたのかを1〜3文で。話題の紹介ではなく結論を書く）',
    '',
    '## 要点',
    `（${preset.bullets}の箇条書き。1項目ごとに内容が分かる完結した文を書き、末尾に該当箇所の [m:ss] を付ける）`,
  ];

  if (preset.detail) {
    sections.push(
      '',
      '## 詳しい内容',
      '（話題ごとに ### 見出しを付けて説明する。見出しにも [m:ss] を付ける。',
      '　手順が説明されている場合は番号付きリストで具体的に書く。',
      '　なぜそうするのかという理由や、失敗例が語られていればそれも書く）',
    );
  }

  sections.push(
    '',
    '## 覚えておきたいこと',
    '（動画中に出てきたツール名・サービス名・URL・数値・金額・専門用語を、意味を添えて箇条書きにする。',
    '　画面に表示されていたものは表示どおりの綴りで書く。該当がなければこの節は省略してよい）',
    '',
    '## 確認が必要な点',
    '（画面の文字が読み取れなかった、音声が不明瞭だったなど、確信が持てない箇所があればここに書く。',
    '　何がどう不確かなのかを1行で書く。該当がなければこの節は省略する）',
  );

  return sections.join('\n');
}

/** 要約を作らせるプロンプト */
function summaryPrompt(preset) {
  return [
    'あなたは動画の内容を、後から見返せる資料にまとめる編集者です。',
    '読む人はこの動画を見ません。資料を読むだけで内容を理解し、説明されていた方法を実行できる必要があります。',
    '',
    'この動画を最初から最後まで見て、日本語で要約を作ってください。',
    '',
    RULES,
    '',
    outputFormat(preset),
    '',
    '出力は要約の本文だけにしてください。「以下が要約です」といった前置きや、最後の感想は書かないでください。',
  ].join('\n');
}

/** 下書きを見直させるプロンプト */
function reviewPrompt(draft, preset) {
  return [
    'あなたは、要約の下書きを動画と突き合わせて確認する校正者です。',
    '',
    'この動画の要約の下書きができました。動画をもう一度確認し、完成版にしてください。',
    '',
    '## あなたができること (この3つだけ)',
    '1. 表記の修正 — 聞き取りや読み取りを誤っている箇所を、動画で確認できる正しい表記に直す',
    '2. 欠落の補充 — 動画で語られている、または画面に映っているのに下書きに入っていない重要な内容を加える',
    '3. 整理 — 重複をまとめる、順序を直す、曖昧な表現を具体化する',
    '',
    '## 絶対にやってはいけないこと',
    '- 動画で確認できない情報を書き足す',
    '- あなた自身が持っている知識で説明を補う',
    '- 固有名詞・URL・数値を推測して書く',
    '- 動画で確認できないことを理由に、下書きの記述を削除する',
    '',
    RULES,
    '',
    outputFormat(preset),
    '',
    '下書きと同じ見出し構成のまま、完成版の要約だけを出力してください。',
    '修正した箇所に印は付けず、完成した文章として読める形にしてください。',
    '',
    '[下書き]',
    draft,
  ].join('\n');
}

/** エラーの文言から、利用者に何をすればよいか伝えられる分類に変える */
function classifyGeminiMessage(status, message, detail) {
  if (/api.?key/i.test(message) && (status === 400 || status === 401)) {
    return new GeminiError('GEMINI_KEY_INVALID', 'Gemini の API キーが正しくありません。', detail);
  }
  if (status === 429 || /quota|rate limit|resource.?exhausted/i.test(message)) {
    return new GeminiError(
      'GEMINI_QUOTA',
      'Gemini の利用上限に達しました。無料枠は1日あたり動画8時間までです。時間をおいてお試しください。',
      detail,
    );
  }
  if (status === 403) {
    return new GeminiError(
      'GEMINI_FORBIDDEN',
      'Gemini API へのアクセスが拒否されました。API キーの権限をご確認ください。',
      detail,
    );
  }
  if (/token count|too (?:large|long)|exceeds/i.test(message)) {
    return new GeminiError('GEMINI_TOO_LONG', '動画が長すぎて処理できませんでした。', detail);
  }
  if (/private|unlisted|not (?:available|found)|unavailable/i.test(message)) {
    return new GeminiError(
      'GEMINI_VIDEO_UNAVAILABLE',
      'Gemini がこの動画を取得できませんでした。限定公開・非公開の動画は扱えません。',
      detail,
    );
  }
  return new GeminiError(
    'GEMINI_ERROR',
    `Gemini の呼び出しに失敗しました${status ? ` (HTTP ${status})` : ''}${message ? `: ${message}` : ''}`,
    detail,
  );
}

/** HTTP のエラー応答を GeminiError に変える。interactions API は本文を配列で返す */
async function toGeminiError(res) {
  let detail = null;
  try {
    const body = await res.json();
    detail = (Array.isArray(body) ? body[0]?.error : body?.error) ?? null;
  } catch {
    /* JSON でない応答 */
  }
  return classifyGeminiMessage(res.status, detail?.message ?? '', detail);
}

/** これ以上状態が変わらない状態 */
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'incomplete', 'budget_exceeded']);

/** 受付番号として受け付ける形式。パスに埋め込むので厳しめに絞る */
const JOB_ID_RE = /^[A-Za-z0-9_.:-]{1,256}$/;

export function isValidJobId(id) {
  return typeof id === 'string' && JOB_ID_RE.test(id);
}

/**
 * 要約 (draft を渡した場合はその検証) を Gemini にバックグラウンドで依頼する。
 *
 * @param {object} env Worker の env (GEMINI_API_KEY を含む)
 * @param {object} params
 * @param {string} params.videoId 動画ID
 * @param {string} params.length 'short' | 'standard' | 'detailed'
 * @param {string} [params.draft] 検証させる下書き。無ければ要約を作らせる
 * @param {string} [params.resolution] 'low' など。長すぎる動画の再試行で使う
 * @returns {Promise<{id: string, status: string, model: string}>}
 */
export async function startGeminiJob(env, { videoId, length, draft, resolution }) {
  const preset = GEMINI_PRESETS[length] ?? GEMINI_PRESETS.standard;
  const model = env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;

  const video = { type: 'video', uri: `https://www.youtube.com/watch?v=${videoId}` };
  if (resolution) video.resolution = resolution;

  const res = await fetch(`${API_BASE}/interactions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': env.GEMINI_API_KEY,
    },
    body: JSON.stringify({
      model,
      background: true,
      input: [video, { type: 'text', text: draft ? reviewPrompt(draft, preset) : summaryPrompt(preset) }],
      generation_config: {
        max_output_tokens: preset.maxTokens,
        // 要約に深い推論は要らない。考える量を減らすと速く、出力の枠も食わない
        thinking_level: 'low',
      },
    }),
  });

  if (!res.ok) throw await toGeminiError(res);

  const interaction = await res.json();
  if (!isValidJobId(interaction?.id)) {
    throw new GeminiError('GEMINI_ERROR', 'Gemini から受付番号が返ってきませんでした。', interaction);
  }
  return { id: interaction.id, status: interaction.status ?? 'in_progress', model };
}

/**
 * 依頼した処理の状態を問い合わせる。
 *
 * @returns {Promise<{done: boolean, status: string, text?: string, truncated?: boolean, error?: {code: string, message: string}}>}
 */
export async function getGeminiJob(env, id) {
  if (!isValidJobId(id)) {
    throw new GeminiError('GEMINI_BAD_REQUEST', '受付番号の形式が正しくありません。', null);
  }

  const res = await fetch(`${API_BASE}/interactions/${encodeURIComponent(id)}`, {
    headers: { 'x-goog-api-key': env.GEMINI_API_KEY },
  });
  if (!res.ok) throw await toGeminiError(res);

  const interaction = await res.json();
  const status = interaction?.status ?? 'in_progress';

  if (!TERMINAL.has(status)) return { done: false, status };

  const text = typeof interaction.output_text === 'string' ? interaction.output_text.trim() : '';

  if (status === 'completed' && text) return { done: true, status, text };

  // 出力の上限で打ち切られた場合も、途中までの要約は使える
  if (status === 'incomplete' && text) return { done: true, status, text, truncated: true };

  const first = interaction.errors?.[0];
  const err =
    status === 'completed' || (status === 'incomplete' && !text)
      ? new GeminiError(
          'GEMINI_EMPTY',
          'Gemini が要約を返しませんでした。限定公開・非公開の動画は扱えません。',
          null,
        )
      : status === 'budget_exceeded'
        ? classifyGeminiMessage(429, 'quota', first ?? null)
        : classifyGeminiMessage(0, first?.message ?? status, first ?? null);

  return { done: true, status, error: { code: err.code, message: err.message } };
}
