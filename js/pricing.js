// モデル定義と単価表（USD / 100万トークン）。改定時はここだけ直す
// 確認日: 2026-10-11（claude-api スキルの公式値）
// キャッシュ書込は5分TTLで入力の1.25倍

export const MODELS = {
  haiku: {
    id: 'claude-haiku-5-5', label: 'Haiku', note: '速い・安い',
    input: 0.10, output: 0.50, cacheWrite: 0.125, cacheRead: 0.01,
    // プロンプトが10万トークンを超えると高い料金表になる
    long: { over: 100000, input: 0.50, output: 2.50, cacheWrite: 0.625, cacheRead: 0.05 },
    search: 'web_search_20250305',
  },
  sonnet: {
    id: 'claude-sonnet-5-5', label: 'Sonnet', note: 'バランス',
    input: 2.00, output: 10.00, cacheWrite: 2.50, cacheRead: 0.20,
    search: 'web_search_20260209',
  },
  opus: {
    id: 'claude-opus-5-5', label: 'Opus', note: 'いちばん賢い',
    input: 4.00, output: 20.00, cacheWrite: 5.00, cacheRead: 0.20,
    search: 'web_search_20260209',
  },
};

// Web検索は1回 $0.01（1000回 $10）
export const SEARCH_PRICE = 0.01;

// モデルIDから定義を引く（フォールバックで別モデルが答えた時用）。不明なら null
export function modelById(id) {
  if (!id) return null;
  for (const m of Object.values(MODELS)) if (id.startsWith(m.id)) return m;
  if (id.includes('haiku')) return MODELS.haiku;
  if (id.includes('sonnet')) return MODELS.sonnet;
  if (id.includes('opus')) return MODELS.opus;
  return null;
}

// usage 1件ぶんのトークン数から金額を出す
function tokensCost(m, u) {
  const inTok = u.input_tokens || 0;
  const cw = u.cache_creation_input_tokens || 0;
  const cr = u.cache_read_input_tokens || 0;
  const out = u.output_tokens || 0;
  let r = m;
  if (m.long && inTok + cw + cr > m.long.over) r = m.long;
  return (inTok * r.input + cw * r.cacheWrite + cr * r.cacheRead + out * r.output) / 1e6;
}

// 応答の usage と、依頼したモデル・実際に答えたモデルから金額を出す
// フォールバックが起きた時だけ iterations を試行ごとに足す（各試行は動いたモデルの単価）
export function calcCost(usage, requestedId, servedId) {
  if (!usage) return 0;
  let usd = 0;
  const its = usage.iterations || [];
  if (its.some((x) => x.type === 'fallback_message')) {
    for (const it of its) {
      if (it.type !== 'message' && it.type !== 'fallback_message') continue;
      const m = modelById(it.model || (it.type === 'fallback_message' ? servedId : requestedId)) || modelById(requestedId);
      if (m) usd += tokensCost(m, it);
    }
  } else {
    const m = modelById(servedId) || modelById(requestedId);
    if (m) usd += tokensCost(m, usage);
  }
  const searches = usage.server_tool_use?.web_search_requests || 0;
  return usd + searches * SEARCH_PRICE;
}
