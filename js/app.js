// 画面・会話管理
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import * as db from './db.js';
import { decryptText } from './crypto.js';
import { MODELS, modelById } from './pricing.js';
import { buildParams, streamChat, cleanForHistory, generateTitle, friendlyError } from './api.js';

const $ = (id) => document.getElementById(id);
const THINKS = { none: 'なし', low: '短', medium: '中', high: '長' };
const CACHE_SEC = 300;
const MAX_IMAGES = 5;
// APIキー関連の保存名は用途がわからない名前にする
const K_CIPHER = 'ui_pref_a';
const K_PASS = 'ui_pref_b';

// ---------- 状態 ----------
let settings = { systemPrompt: '', defModel: 'sonnet', defThink: 'medium', theme: 'auto', yenRate: 150, budget: 100 };
let convs = [];          // 全会話（更新日時の新しい順）
let current = null;      // 表示中の会話。未保存の新規会話もここに入る
let selModel = 'sonnet'; // 未保存の新規会話用のモデル・思考
let selThink = 'medium';
let searchOn = false;
let attachments = [];    // { media_type, data }
let busy = false;
let abortCtrl = null;

marked.setOptions({ gfm: true, breaks: true });
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer'); }
});
const md = (text) => DOMPurify.sanitize(marked.parse(text || ''));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- 起動 ----------
init();

async function init() {
  db.requestPersist();
  const saved = await db.kvGet('settings');
  if (saved) settings = { ...settings, ...saved };
  selModel = settings.defModel;
  selThink = settings.defThink;
  convs = ((await db.convAll()) || []).sort((a, b) => b.updated - a.updated);
  applyTheme(settings.theme);
  bindUI();
  newConversation();
  setInterval(updateCacheTimer, 1000);
  updateOnline();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

// ---------- 会話の切り替え ----------
function newConversation() {
  current = null;
  selModel = settings.defModel;
  selThink = settings.defThink;
  renderChat();
  closeDrawer();
}

function openConversation(id) {
  const c = convs.find((x) => x.id === id);
  if (!c) return;
  current = c;
  renderChat();
  closeDrawer();
}

function convModel() { return current ? current.model : selModel; }
function convThink() { return current ? current.think : selThink; }

async function saveConv(c) {
  c.updated = Date.now();
  if (!convs.includes(c)) convs.unshift(c);
  convs.sort((a, b) => b.updated - a.updated);
  await db.convPut(c);
}

// ---------- 描画 ----------
function renderChat() {
  const chat = $('chat');
  chat.querySelectorAll('.msg, .error-box').forEach((el) => el.remove());
  const msgs = current ? current.messages : [];
  $('empty').hidden = msgs.length > 0;
  for (const m of msgs) {
    if (m.role === 'user') chat.appendChild(userEl(m));
    else if (m.role === 'assistant') chat.appendChild(assistantEl(m, false));
  }
  $('convTitle').textContent = current ? current.title : '新しい会話';
  updateModelChip();
  updateCacheTimer();
  chat.scrollTop = chat.scrollHeight;
}

function userEl(m) {
  const el = document.createElement('div');
  el.className = 'msg user';
  const imgs = m.content.filter((b) => b.type === 'image');
  const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  if (imgs.length) {
    const box = document.createElement('div');
    box.className = 'imgs';
    for (const b of imgs) {
      const img = document.createElement('img');
      img.src = `data:${b.source.media_type};base64,${b.source.data}`;
      box.appendChild(img);
    }
    el.appendChild(box);
  }
  if (text) {
    const bub = document.createElement('div');
    bub.className = 'bubble';
    bub.textContent = text;
    el.appendChild(bub);
  }
  return el;
}

function assistantEl(m, streaming) {
  const el = document.createElement('div');
  el.className = 'msg assistant';
  fillAssistant(el, m.content, streaming, m);
  return el;
}

// content ブロック列を描画する。ストリーミング中も同じ関数で毎フレーム描き直す
function fillAssistant(el, content, streaming, meta = {}) {
  const openThinks = [...el.querySelectorAll('details.think')].map((d) => d.open);
  let html = '';
  let textBuf = '';
  const sources = new Map();
  const searchHits = [];
  const resultIds = new Set(content.filter((b) => b.tool_use_id).map((b) => b.tool_use_id));
  const flush = () => { if (textBuf) { html += `<div class="md">${md(textBuf)}</div>`; textBuf = ''; } };
  let thinkIdx = 0;
  content.forEach((b, i) => {
    const last = i === content.length - 1;
    if (b.type === 'text') {
      textBuf += b.text;
      for (const c of b.citations || []) if (c.url && !sources.has(c.url)) sources.set(c.url, c.title || c.url);
      return;
    }
    flush();
    if (b.type === 'thinking') {
      if (b.thinking) {
        const live = streaming && last;
        html += `<details class="think"${openThinks[thinkIdx] ? ' open' : ''}><summary class="${live ? 'pulse' : ''}">${live ? '考えています…' : '思考の要約'}</summary><div class="think-body">${esc(b.thinking)}</div></details>`;
        thinkIdx++;
      } else if (streaming && last) {
        html += '<div class="status pulse">考えています…</div>';
      }
    } else if (b.type === 'server_tool_use' && b.name === 'web_search') {
      const q = b.input?.query ? `「${esc(b.input.query)}」` : '';
      const waiting = streaming && !resultIds.has(b.id);
      html += `<div class="status${waiting ? ' pulse' : ''}">🔍 ${q}${waiting ? 'を検索中…' : 'を検索'}</div>`;
    } else if (b.type === 'web_search_tool_result') {
      if (Array.isArray(b.content)) searchHits.push(...b.content.filter((r) => r.url));
      else html += '<div class="status">検索できませんでした</div>';
    } else if (b.type === 'fallback') {
      html += '<div class="note">安全上の理由で、別のモデルが回答を引き継ぎました。</div>';
    }
  });
  flush();
  if (streaming && content.length === 0) html += '<div class="status pulse">…</div>';
  if (!sources.size) for (const r of searchHits.slice(0, 5)) sources.set(r.url, r.title || r.url);
  if (sources.size) {
    html += '<div class="sources">' + [...sources].map(([u, t]) =>
      `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(hostOf(u))}・${esc(t)}</a>`).join('') + '</div>';
  }
  if (!streaming) {
    if (meta.stop === 'max_tokens') html += '<div class="note">長くなりすぎたため、途中で終わっています。</div>';
    if (meta.aborted) html += '<div class="note">中断しました。</div>';
    html += `<div class="msg-actions"><button data-act="copy" aria-label="コピー"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg></button></div>`;
  }
  el.innerHTML = html;
  const copyBtn = el.querySelector('[data-act="copy"]');
  if (copyBtn) {
    copyBtn.onclick = () => {
      const all = content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      navigator.clipboard.writeText(all).then(() => toast('コピーしました'));
    };
  }
}

function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } }

function nearBottom() { const c = $('chat'); return c.scrollHeight - c.scrollTop - c.clientHeight < 120; }
function toBottom() { const c = $('chat'); c.scrollTop = c.scrollHeight; }

function showError(text) {
  const box = document.createElement('div');
  box.className = 'error-box';
  box.textContent = text;
  $('chat').appendChild(box);
  toBottom();
}

// ---------- 送信 ----------
async function getApiKey() {
  const cipher = await db.kvGet(K_CIPHER);
  const pass = await db.kvGet(K_PASS);
  if (!cipher || !pass) return null;
  try { return await decryptText(cipher, pass); } catch { return null; }
}

function todayNote() {
  const d = new Date();
  const w = '日月火水木金土'[d.getDay()];
  return `今日の日付は${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${w}）です。`;
}

async function send() {
  if (busy) return;
  const text = $('input').value.trim();
  if (!text && !attachments.length) return;
  let apiKey = await getApiKey();
  if (!apiKey) { toast('先に設定でAPIキーを登録してください'); openSettings(); return; }

  if (!current) {
    current = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      title: '新しい会話', titled: false, created: Date.now(), updated: Date.now(),
      model: selModel, think: selThink, system: settings.systemPrompt, messages: [],
    };
  }
  const conv = current;
  const sentImages = attachments;
  const content = sentImages.map((a) => ({ type: 'image', source: { type: 'base64', media_type: a.media_type, data: a.data } }));
  if (text) content.push({ type: 'text', text });
  const added = [{ role: 'user', content, at: Date.now() }];
  // 日付が変わったら会話の途中に system メッセージで知らせる（履歴を書き換えずに済む）
  const note = todayNote();
  const lastNote = [...conv.messages].reverse().find((m) => m.role === 'system');
  if (!lastNote || lastNote.content !== note) added.push({ role: 'system', content: note });
  conv.messages.push(...added);

  $('input').value = '';
  attachments = [];
  renderAttachments();
  autoGrow();
  $('empty').hidden = true;
  $('chat').appendChild(userEl(added[0]));
  const aEl = assistantEl({ content: [] }, true);
  $('chat').appendChild(aEl);
  toBottom();
  await saveConv(conv);
  $('convTitle').textContent = conv.title;

  setBusy(true);
  abortCtrl = new AbortController();
  const params = buildParams({
    modelKey: conv.model, think: conv.think, search: searchOn, system: conv.system,
    messages: conv.messages.map((m) => ({ role: m.role, content: m.content })),
  });
  const cacheKey = { model: conv.model, think: conv.think, search: searchOn };
  let lastContent = [];
  let lastSnap = null;
  let raf = 0;
  try {
    const res = await streamChat({
      apiKey, params, signal: abortCtrl.signal,
      onUpdate: (c, snap) => {
        lastContent = c; lastSnap = snap;
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          if (current !== conv) return;
          const stick = nearBottom();
          fillAssistant(aEl, lastContent, true);
          if (stick) toBottom();
        });
      },
    });
    cancelAnimationFrame(raf);
    await addCost(res.cost, res.servedModel);
    if (res.stopReason === 'refusal') {
      rollback(conv, added, text, sentImages);
      if (current === conv) { renderChat(); showError('この内容には答えられませんでした（安全上の理由）。言い方を変えて送ってみてください。'); }
      return;
    }
    const entry = { role: 'assistant', content: cleanForHistory(res.content), at: Date.now(), model: res.servedModel, cost: res.cost, stop: res.stopReason };
    conv.messages.push(entry);
    conv.cache = { at: res.startedAt, ...cacheKey };
    await saveConv(conv);
    if (current === conv) { fillAssistant(aEl, entry.content, false, entry); updateCacheTimer(); }
    if (!conv.titled) makeTitle(conv, apiKey, text, entry);
  } catch (err) {
    cancelAnimationFrame(raf);
    const msg = friendlyError(err);
    if (msg === 'aborted') {
      // 中断: 途中までの文章だけ残す。文章がまだ無ければ送信自体を取り消す
      if (lastSnap?.usage) await addCost(estimateCost(lastSnap, params.model), params.model);
      const partial = lastContent.filter((b) => b.type === 'text' && b.text).map((b) => ({ type: 'text', text: b.text }));
      if (partial.length) {
        const entry = { role: 'assistant', content: partial, at: Date.now(), model: params.model, aborted: true };
        conv.messages.push(entry);
        await saveConv(conv);
        if (current === conv) fillAssistant(aEl, entry.content, false, entry);
      } else {
        rollback(conv, added, text, sentImages);
        if (current === conv) renderChat();
      }
    } else {
      rollback(conv, added, text, sentImages);
      if (current === conv) { renderChat(); showError(msg); }
    }
  } finally {
    apiKey = null;
    abortCtrl = null;
    setBusy(false);
  }
}

// 失敗した送信を取り消し、入力欄に戻す
function rollback(conv, added, text, images) {
  for (const m of added) {
    const i = conv.messages.lastIndexOf(m);
    if (i >= 0) conv.messages.splice(i, 1);
  }
  if (conv.messages.length) saveConv(conv);
  else {
    db.convDel(conv.id);
    convs = convs.filter((c) => c !== conv);
  }
  if (current === conv) {
    $('input').value = text;
    attachments = images;
    renderAttachments();
    autoGrow();
  }
}

// 中断時の概算（入力分と、そこまでの出力分）
function estimateCost(snap, modelId) {
  const m = modelById(snap.model) || modelById(modelId);
  if (!m) return 0;
  const u = snap.usage;
  return ((u.input_tokens || 0) * m.input + (u.cache_creation_input_tokens || 0) * m.cacheWrite +
    (u.cache_read_input_tokens || 0) * m.cacheRead + (u.output_tokens || 0) * m.output) / 1e6;
}

async function makeTitle(conv, apiKey, userText, entry) {
  const answer = entry.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const q = userText || '（画像）';
  try {
    const r = await generateTitle(apiKey, q, answer);
    await addCost(r.cost, MODELS.haiku.id);
    if (r.title && !conv.titled) {
      conv.title = r.title;
      conv.titled = true;
      await saveConv(conv);
      if (current === conv) $('convTitle').textContent = conv.title;
      renderDrawer();
    }
  } catch { /* タイトルは失敗しても困らない */ }
}

function setBusy(b) {
  busy = b;
  $('btnSend').classList.toggle('busy', b);
  $('btnSend').setAttribute('aria-label', b ? '中断' : '送信');
  updateSendEnabled();
}

function updateSendEnabled() {
  $('btnSend').disabled = !busy && !$('input').value.trim() && !attachments.length;
}

// ---------- 利用額の集計（毎月15日で区切る） ----------
function periodKey(d = new Date()) {
  let y = d.getFullYear(), m = d.getMonth() + 1;
  if (d.getDate() < 15) { m -= 1; if (m === 0) { m = 12; y -= 1; } }
  return `${y}-${String(m).padStart(2, '0')}`;
}
function periodLabel(key) {
  const [y, m] = key.split('-').map(Number);
  const nm = m === 12 ? 1 : m + 1;
  return `${m}/15〜${nm}/14`;
}

async function addCost(usd, modelId) {
  if (!usd) return;
  const stat = (await db.kvGet('stat')) || { periods: {} };
  const key = periodKey();
  const p = stat.periods[key] || (stat.periods[key] = { total: 0, models: {} });
  const label = modelById(modelId)?.label || 'その他';
  p.total += usd;
  p.models[label] = (p.models[label] || 0) + usd;
  await db.kvSet('stat', stat);
}

const fmtUsd = (v) => '$' + v.toFixed(2);
const fmtYen = (v) => '¥' + Math.round(v * settings.yenRate).toLocaleString();

async function renderCost() {
  const stat = (await db.kvGet('stat')) || { periods: {} };
  const key = periodKey();
  const p = stat.periods[key] || { total: 0, models: {} };
  $('costNow').textContent = `${fmtUsd(p.total)} / $${settings.budget}`;
  $('costSub').textContent = `${fmtYen(p.total)}　（${periodLabel(key)}）`;
  const ratio = Math.min(1, p.total / settings.budget);
  $('costBar').style.width = (ratio * 100).toFixed(1) + '%';
  $('costBar').classList.toggle('warn', ratio >= 0.8);
  $('costModels').innerHTML = Object.entries(p.models).map(([k, v]) =>
    `<div><span>${esc(k)}</span><span>${fmtUsd(v)}（${fmtYen(v)}）</span></div>`).join('');
  const past = Object.keys(stat.periods).filter((k) => k !== key).sort().reverse();
  $('costHistory').innerHTML = past.length
    ? past.map((k) => `<div><span>${k.replace('-', '年')}月〜</span><span>${fmtUsd(stat.periods[k].total)}</span></div>`).join('')
    : '<div class="muted">まだありません</div>';
}

// ---------- キャッシュタイマー ----------
function updateCacheTimer() {
  const el = $('cacheTimer');
  const c = current?.cache;
  if (!c || c.model !== convModel() || c.think !== convThink() || c.search !== searchOn) {
    el.textContent = ''; el.className = 'cache'; return;
  }
  const left = Math.max(0, CACHE_SEC - Math.floor((Date.now() - c.at) / 1000));
  el.textContent = `⏱ ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  el.className = 'cache ' + (left > 0 ? 'live' : 'out');
}

// ---------- モデル選択シート ----------
function updateModelChip() {
  const m = MODELS[convModel()];
  const t = convThink();
  $('modelLabel').textContent = t === 'none' ? m.label : `${m.label}・思考${THINKS[t]}`;
}

function renderSheet() {
  const mk = convModel(), tk = convThink();
  $('segModel').innerHTML = Object.entries(MODELS).map(([k, m]) =>
    `<button data-v="${k}" aria-pressed="${k === mk}">${m.label}<small>${m.note}</small></button>`).join('');
  $('segThink').innerHTML = Object.entries(THINKS).map(([k, l]) =>
    `<button data-v="${k}" aria-pressed="${k === tk}"${mk === 'opus' && k === 'none' ? ' disabled' : ''}>${l}</button>`).join('');
  $('thinkNote').textContent = mk === 'opus'
    ? 'Opusは思考を切れないため「短」がいちばん軽い設定です。'
    : '思考を長くすると、答えは丁寧になりますが時間と料金が増えます。';
}

async function setModelThink(model, think) {
  if (model === 'opus' && think === 'none') think = 'low';
  if (current) {
    current.model = model; current.think = think;
    if (current.messages.length) await saveConv(current);
  } else { selModel = model; selThink = think; }
  renderSheet();
  updateModelChip();
  updateCacheTimer();
}

function openSheet() { renderSheet(); $('sheetScrim').hidden = false; $('modelSheet').classList.add('open'); }
function closeSheet() { $('sheetScrim').hidden = true; $('modelSheet').classList.remove('open'); }

// ---------- 会話一覧 ----------
function renderDrawer() {
  const list = $('convList');
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const groupOf = (t) => t >= startToday ? '今日' : t >= startToday - 864e5 ? '昨日' : t >= startToday - 7 * 864e5 ? '7日以内' : 'それ以前';
  let html = '', lastGroup = '';
  for (const c of convs) {
    const g = groupOf(c.updated);
    if (g !== lastGroup) { html += `<div class="conv-group">${g}</div>`; lastGroup = g; }
    html += `<button class="conv-item${current === c ? ' active' : ''}" data-id="${c.id}">${esc(c.title)}</button>`;
  }
  list.innerHTML = html || '<div class="conv-group">まだ会話はありません</div>';
}

function openDrawer() { renderDrawer(); $('drawerScrim').hidden = false; $('drawer').classList.add('open'); }
function closeDrawer() { $('drawerScrim').hidden = true; $('drawer').classList.remove('open'); }

async function convActions(id) {
  const c = convs.find((x) => x.id === id);
  if (!c) return;
  const act = await dialog({ message: c.title, buttons: [
    { label: '名前を変更', value: 'rename' }, { label: '削除', value: 'delete', cls: 'danger' }, { label: 'キャンセル', value: null },
  ] });
  if (act === 'rename') renameConv(c);
  if (act === 'delete') {
    const ok = await dialog({ message: `「${c.title}」を削除しますか？\n元に戻せません。`, buttons: [
      { label: '削除する', value: true, cls: 'danger' }, { label: 'キャンセル', value: false },
    ] });
    if (!ok) return;
    await db.convDel(c.id);
    convs = convs.filter((x) => x !== c);
    if (current === c) newConversation();
    renderDrawer();
  }
}

async function renameConv(c) {
  const r = await dialog({ message: '会話の名前', input: c.title, buttons: [
    { label: '変更', value: 'ok', cls: 'primary' }, { label: 'キャンセル', value: null },
  ] });
  if (r !== 'ok') return;
  const v = $('dialogInput').value.trim();
  if (!v) return;
  c.title = v; c.titled = true;
  await saveConv(c);
  if (current === c) $('convTitle').textContent = v;
  renderDrawer();
}

// ---------- 設定 ----------
async function openSettings() {
  $('systemPrompt').value = settings.systemPrompt;
  $('defModel').innerHTML = Object.entries(MODELS).map(([k, m]) => `<option value="${k}">${m.label}（${m.note}）</option>`).join('');
  $('defModel').value = settings.defModel;
  $('defThink').innerHTML = Object.entries(THINKS).map(([k, l]) => `<option value="${k}">${l}</option>`).join('');
  $('defThink').value = settings.defThink;
  $('yenRate').value = settings.yenRate;
  $('budget').value = settings.budget;
  renderThemeSeg();
  $('keyCipher').value = '';
  $('keyPass').value = '';
  const has = (await db.kvGet(K_CIPHER)) && (await db.kvGet(K_PASS));
  $('keyStatus').textContent = has ? '登録済み（変更するときだけ入力）' : '未登録';
  await renderCost();
  $('settings').classList.add('open');
}
function closeSettings() { $('settings').classList.remove('open'); }

async function saveSettings() { await db.kvSet('settings', settings); }

function renderThemeSeg() {
  const opts = { auto: '自動', light: 'ライト', dark: 'ダーク' };
  $('segTheme').innerHTML = Object.entries(opts).map(([k, l]) =>
    `<button data-v="${k}" aria-pressed="${k === settings.theme}">${l}</button>`).join('');
}

function applyTheme(t) {
  const root = document.documentElement;
  if (t === 'light' || t === 'dark') root.dataset.theme = t; else delete root.dataset.theme;
  try { localStorage.setItem('theme', t); } catch { /* 保存できなくても表示は切り替わる */ }
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
  document.querySelector('meta[name="theme-color"]').setAttribute('content', bg || '#ffffff');
}

async function saveKey() {
  const cipher = $('keyCipher').value.trim();
  const pass = $('keyPass').value;
  if (!cipher || !pass) { toast('暗号文と合言葉の両方を入れてください'); return; }
  try { await decryptText(cipher, pass); } catch { toast('復号できません。暗号文か合言葉が違います'); return; }
  await db.kvSet(K_CIPHER, cipher);
  await db.kvSet(K_PASS, pass);
  $('keyCipher').value = ''; $('keyPass').value = '';
  $('keyStatus').textContent = '登録済み（変更するときだけ入力）';
  toast('APIキーを保存しました');
}

async function clearKey() {
  const ok = await dialog({ message: 'この端末からAPIキーを削除しますか？', buttons: [
    { label: '削除する', value: true, cls: 'danger' }, { label: 'キャンセル', value: false },
  ] });
  if (!ok) return;
  await db.kvDel(K_CIPHER); await db.kvDel(K_PASS);
  $('keyStatus').textContent = '未登録';
  toast('削除しました');
}

async function exportHistory() {
  const data = { app: 'AIChat', format: 1, exportedAt: new Date().toISOString(), conversations: convs };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  const d = new Date();
  a.href = URL.createObjectURL(blob);
  a.download = `AIChat_${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function importHistory(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'AIChat' || !Array.isArray(data.conversations)) throw new Error('形式が違います');
    let n = 0;
    for (const c of data.conversations) {
      if (!c.id || !Array.isArray(c.messages)) continue;
      const old = convs.find((x) => x.id === c.id);
      if (old && old.updated >= c.updated) continue;
      await db.convPut(c);
      convs = convs.filter((x) => x.id !== c.id);
      convs.push(c);
      n++;
    }
    convs.sort((a, b) => b.updated - a.updated);
    toast(`${n}件の会話を読み込みました`);
  } catch (e) {
    toast('読み込めませんでした: ' + e.message);
  }
}

// ---------- 写真添付 ----------
async function addImages(files) {
  for (const f of files) {
    if (attachments.length >= MAX_IMAGES) { toast(`写真は${MAX_IMAGES}枚までです`); break; }
    try { attachments.push(await resizeImage(f)); } catch { toast('この画像は読み込めませんでした'); }
  }
  renderAttachments();
  updateSendEnabled();
}

// 長辺1568pxに縮小してJPEG化（トークン節約）
async function resizeImage(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, 1568 / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  const url = cv.toDataURL('image/jpeg', 0.85);
  return { media_type: 'image/jpeg', data: url.slice(url.indexOf(',') + 1) };
}

function renderAttachments() {
  $('attachPreview').innerHTML = attachments.map((a, i) =>
    `<div class="att"><img src="data:${a.media_type};base64,${a.data}"><button data-i="${i}" aria-label="外す">×</button></div>`).join('');
}

// ---------- 小物 ----------
function autoGrow() {
  const t = $('input');
  t.style.height = 'auto';
  t.style.height = t.scrollHeight + 'px';
  updateSendEnabled();
}

let toastTimer = 0;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

// 汎用ダイアログ。押したボタンの value を返す
function dialog({ message, input, buttons }) {
  return new Promise((resolve) => {
    $('dialogMsg').textContent = message;
    const inp = $('dialogInput');
    inp.hidden = input === undefined;
    inp.value = input ?? '';
    const box = $('dialogBtns');
    box.innerHTML = '';
    for (const b of buttons) {
      const btn = document.createElement('button');
      btn.textContent = b.label;
      if (b.cls) btn.className = b.cls;
      btn.onclick = () => { $('dialog').hidden = true; resolve(b.value); };
      box.appendChild(btn);
    }
    $('dialog').hidden = false;
    if (!inp.hidden) setTimeout(() => inp.focus(), 50);
  });
}

function updateOnline() { $('offline').hidden = navigator.onLine; }

// ---------- イベント登録 ----------
function bindUI() {
  $('btnMenu').onclick = openDrawer;
  $('drawerScrim').onclick = closeDrawer;
  $('btnNew').onclick = () => { if (!busy) newConversation(); };
  $('btnSettings').onclick = openSettings;
  $('btnSettingsClose').onclick = closeSettings;
  $('convTitle').onclick = () => { if (current?.messages.length) renameConv(current); };

  // 会話一覧: タップで開く、長押し（Androidでは contextmenu が出る）で操作メニュー
  let pressTimer = 0, pressed = false, startXY = null;
  const list = $('convList');
  list.addEventListener('click', (e) => {
    const item = e.target.closest('.conv-item');
    if (!item) return;
    if (pressed) { pressed = false; return; }
    if (!busy) openConversation(item.dataset.id);
  });
  list.addEventListener('contextmenu', (e) => {
    const item = e.target.closest('.conv-item');
    if (!item) return;
    e.preventDefault();
    clearTimeout(pressTimer);
    if (!pressed) { pressed = true; convActions(item.dataset.id); }
  });
  list.addEventListener('pointerdown', (e) => {
    const item = e.target.closest('.conv-item');
    if (!item) return;
    pressed = false;
    startXY = [e.clientX, e.clientY];
    pressTimer = setTimeout(() => { pressed = true; convActions(item.dataset.id); }, 550);
  });
  const cancelPress = () => clearTimeout(pressTimer);
  list.addEventListener('pointerup', cancelPress);
  list.addEventListener('pointercancel', cancelPress);
  list.addEventListener('pointermove', (e) => {
    if (startXY && Math.hypot(e.clientX - startXY[0], e.clientY - startXY[1]) > 10) cancelPress();
  });

  // モデル選択シート
  $('btnModel').onclick = openSheet;
  $('sheetScrim').onclick = closeSheet;
  $('segModel').onclick = (e) => { const b = e.target.closest('button'); if (b) setModelThink(b.dataset.v, convThink()); };
  $('segThink').onclick = (e) => { const b = e.target.closest('button'); if (b && !b.disabled) setModelThink(convModel(), b.dataset.v); };

  $('btnSearch').onclick = () => {
    searchOn = !searchOn;
    $('btnSearch').setAttribute('aria-pressed', String(searchOn));
    toast(searchOn ? 'Web検索をオンにしました' : 'Web検索をオフにしました');
    updateCacheTimer();
  };

  // 入力欄
  $('input').addEventListener('input', autoGrow);
  $('input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
  });
  $('btnSend').onclick = () => { if (busy) abortCtrl?.abort(); else send(); };
  $('btnPhoto').onclick = () => $('fileInput').click();
  $('fileInput').onchange = (e) => { addImages([...e.target.files]); e.target.value = ''; };
  $('attachPreview').onclick = (e) => {
    const b = e.target.closest('button[data-i]');
    if (!b) return;
    attachments.splice(Number(b.dataset.i), 1);
    renderAttachments();
    updateSendEnabled();
  };

  // 設定
  $('btnKeySave').onclick = saveKey;
  $('btnKeyClear').onclick = clearKey;
  $('systemPrompt').onchange = () => { settings.systemPrompt = $('systemPrompt').value; saveSettings(); };
  $('defModel').onchange = () => {
    settings.defModel = $('defModel').value;
    if (settings.defModel === 'opus' && settings.defThink === 'none') { settings.defThink = 'low'; $('defThink').value = 'low'; }
    saveSettings();
  };
  $('defThink').onchange = () => {
    settings.defThink = $('defThink').value;
    if (settings.defModel === 'opus' && settings.defThink === 'none') { settings.defThink = 'low'; $('defThink').value = 'low'; }
    saveSettings();
  };
  $('segTheme').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    settings.theme = b.dataset.v;
    applyTheme(settings.theme);
    renderThemeSeg();
    saveSettings();
  };
  $('yenRate').onchange = () => { const v = Number($('yenRate').value); if (v > 0) { settings.yenRate = v; saveSettings(); renderCost(); } };
  $('budget').onchange = () => { const v = Number($('budget').value); if (v > 0) { settings.budget = v; saveSettings(); renderCost(); } };
  $('btnExport').onclick = exportHistory;
  $('btnImport').onclick = () => $('importFile').click();
  $('importFile').onchange = (e) => { const f = e.target.files[0]; if (f) importHistory(f); e.target.value = ''; };

  // 端末のテーマが変わった時（自動のとき）にバーの色を合わせる
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(settings.theme));
  window.addEventListener('online', updateOnline);
  window.addEventListener('offline', updateOnline);
}
