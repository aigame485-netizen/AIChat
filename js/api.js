// Claude API 呼び出し（ブラウザから直接）。ストリーミング・pause_turn の継続・料金計算
import Anthropic from '@anthropic-ai/sdk';
import { MODELS, calcCost } from './pricing.js';

const MAX_TOKENS = 32000;
const MAX_CONTINUE = 5; // Web検索の pause_turn を続けて再開する上限

function makeClient(apiKey) {
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
}

// 思考の設定。思考なしはモデルごとに書き方が違う
//   Haiku: disabled / Sonnet: between_tools / Opus: 切れないので effort low で代用
function thinkingFor(modelKey, think) {
  if (think === 'none') {
    if (modelKey === 'haiku') return { thinking: { type: 'disabled' }, effort: 'low' };
    if (modelKey === 'sonnet') return { thinking: { type: 'between_tools' }, effort: 'low' };
    return { thinking: { type: 'adaptive', display: 'summarized' }, effort: 'low' };
  }
  return { thinking: { type: 'adaptive', display: 'summarized' }, effort: think };
}

// 送信パラメータを組み立てる。messages は API 形式（role/content）
export function buildParams({ modelKey, think, search, system, messages }) {
  const m = MODELS[modelKey];
  const t = thinkingFor(modelKey, think);
  const p = {
    model: m.id,
    max_tokens: MAX_TOKENS,
    messages,
    thinking: t.thinking,
    output_config: { effort: t.effort },
    // 自動キャッシュ: 最後のブロックまでをキャッシュする
    cache_control: { type: 'ephemeral' },
  };
  if (system) p.system = [{ type: 'text', text: system }];
  if (search) {
    p.tools = [{
      type: m.search, name: 'web_search', max_uses: 5,
      user_location: { type: 'approximate', country: 'JP', timezone: 'Asia/Tokyo' },
    }];
  }
  // 安全分類器で断られた時に別モデルで答え直す（Opus/Sonnet のみ。between_tools とは併用しない）
  if (modelKey !== 'haiku' && t.thinking.type !== 'between_tools') {
    p.fallbacks = 'default';
    p.betas = ['server-side-fallback-2026-07-01'];
  }
  return p;
}

// ストリーミングで1ターン送る。onUpdate(content, snapshot) が描画用に何度も呼ばれる
// 戻り値: { content, stopReason, cost, servedModel, startedAt }
// startedAt は最後のリクエストの開始時刻（キャッシュの寿命はここから数える）
export async function streamChat({ apiKey, params, onUpdate, signal }) {
  const client = makeClient(apiKey);
  let prior = []; // pause_turn で中断した分の content
  let cost = 0;
  let p = params;
  let startedAt = Date.now();
  for (let i = 0; ; i++) {
    startedAt = Date.now();
    const stream = client.beta.messages.stream(p, { signal });
    stream.on('streamEvent', (_ev, snap) => onUpdate([...prior, ...snap.content], snap, cost));
    const msg = await stream.finalMessage();
    cost += calcCost(msg.usage, p.model, msg.model);
    if (msg.stop_reason === 'pause_turn' && i < MAX_CONTINUE) {
      // 検索ループが上限で一時停止 → 途中経過を assistant として送り直すとサーバーが再開する
      prior = [...prior, ...msg.content];
      p = { ...p, messages: [...params.messages, { role: 'assistant', content: prior }] };
      continue;
    }
    return { content: [...prior, ...msg.content], stopReason: msg.stop_reason, cost, servedModel: msg.model, startedAt };
  }
}

// 履歴に保存する形に整える
// フォールバックが途中で起きた時は、境界より前の thinking / tool_use 等を送り返してはいけない
const KEEP_BEFORE_FALLBACK = new Set(['text', 'server_tool_use', 'web_search_tool_result', 'web_fetch_tool_result']);
export function cleanForHistory(content) {
  const fb = content.map((b) => b.type).lastIndexOf('fallback');
  const resultIds = new Set(content.filter((b) => b.tool_use_id).map((b) => b.tool_use_id));
  return content.filter((b, i) => {
    if (b.type === 'fallback') return false;
    if (i < fb && !KEEP_BEFORE_FALLBACK.has(b.type)) return false;
    if (b.type === 'server_tool_use' && !resultIds.has(b.id)) return false; // 結果のない検索呼び出し
    return true;
  });
}

// タイトル自動生成（Haiku・思考なし）。戻り値 { title, cost }
export async function generateTitle(apiKey, userText, answerText) {
  const client = makeClient(apiKey);
  const msg = await client.messages.create({
    model: MODELS.haiku.id,
    max_tokens: 200,
    thinking: { type: 'disabled' },
    output_config: { effort: 'low' },
    messages: [{
      role: 'user',
      content: `次の会話に、内容がひと目でわかる日本語のタイトルを付けてください。15文字以内。タイトルだけを出力し、かぎかっこや記号は付けないこと。\n\n【質問】\n${userText.slice(0, 800)}\n\n【回答の冒頭】\n${answerText.slice(0, 600)}`,
    }],
  });
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  return { title: text.replace(/^["「『]|["」』]$/g, '').slice(0, 30), cost: calcCost(msg.usage, MODELS.haiku.id, msg.model) };
}

// エラーを利用者向けの日本語にする。中断は 'aborted' を返す
export function friendlyError(err) {
  if (err instanceof Anthropic.APIUserAbortError) return 'aborted';
  if (err instanceof Anthropic.APIConnectionError) return '通信できませんでした。電波の良いところで、もう一度送ってください。';
  if (err instanceof Anthropic.APIError) {
    const raw = err.error?.error?.message || err.message || '';
    if (/credit balance/i.test(raw)) return '今月のAPIクレジットを使い切りました。毎月15日の更新後にまた使えます。';
    if (err.status === 401) return 'APIキーが使えません。設定のAPIキーを確認してください。';
    if (err.status === 403) return 'このAPIキーでは使えない操作です。（' + raw + '）';
    if (err.status === 429) return '短時間に使いすぎたため一時的に止まっています。1分ほど待ってから送ってください。';
    if (err.status === 529 || err.status >= 500) return 'Claude側が混み合っています。少し待ってから送ってください。';
    return 'エラーになりました（' + err.status + '）: ' + raw;
  }
  return 'エラーになりました: ' + (err?.message || err);
}
