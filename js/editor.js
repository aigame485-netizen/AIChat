// 編集所の画面: 本文タブ・ファイル一覧・変更の確認（反映／差し戻し）・版履歴・取り込み/書き出し
// 会話タブと送信は app.js が受け持つ。ここは ui（toast / dialog / esc など）を app.js から受け取って動く
import { diffChars, diffLines } from 'diff';
import * as db from './db.js';
import { TOOL_DEFS, TOOL_RULES, runTool as runToolCore, fileListText, normName } from './tools.js';

const $ = (id) => document.getElementById(id);
const AUTO_VERSIONS_MAX = 30;
const SAVE_DELAY = 600;

let ui = null;           // { toast, dialog, esc, sendQuote(text), onPendingChange(), isBusy() }
let files = new Map();   // name → { name, text, updated }
let currentName = null;  // 本文タブで開いているファイル
let pending = [];        // 確認待ちの変更（新しい順）
let saveTimer = 0;
let dirty = false;
let versionedThisTurn = new Set(); // 同じ応答の中で自動版を取ったファイル
let reviewIndex = 0;

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const fmtChars = (n) => n.toLocaleString() + '字';

// ---------- 初期化 ----------
export async function initEditor(_ui) {
  ui = _ui;
  for (const f of (await db.fileAll()) || []) files.set(f.name, f);
  pending = ((await db.changeAll()) || []).sort((a, b) => b.at - a.at);
  currentName = (await db.kvGet('editorFile')) || null;
  if (currentName && !files.has(currentName)) currentName = null;
  if (!currentName) currentName = sortedNames()[0] || null;
  bind();
  renderFile();
  renderPendingBar();
}

function sortedNames() { return [...files.keys()].sort((a, b) => a.localeCompare(b, 'ja')); }
export const fileNames = sortedNames;
export const pendingCount = () => pending.length;
export const hasFiles = () => files.size > 0;

// ---------- ファイルの保存 ----------
async function persist(name) {
  const f = files.get(name);
  if (f) await db.filePut(f);
}

function scheduleSave() {
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, SAVE_DELAY);
}

export async function flushSave() {
  clearTimeout(saveTimer);
  if (!dirty || !currentName) return;
  const f = files.get(currentName);
  if (!f) return;
  f.text = $('editorText').value;
  f.updated = Date.now();
  dirty = false;
  await persist(currentName);
}

async function setText(name, text) {
  const f = files.get(name);
  if (!f) return;
  f.text = text;
  f.updated = Date.now();
  await persist(name);
  if (name === currentName) { $('editorText').value = text; dirty = false; updateCount(); }
}

// ---------- 本文タブの描画 ----------
function renderFile() {
  const ta = $('editorText');
  const f = currentName ? files.get(currentName) : null;
  $('editorEmpty').hidden = !!f;
  ta.hidden = !f;
  $('editorStatus').hidden = !f;
  $('fileName').textContent = f ? f.name : 'ファイルなし';
  if (f) { ta.value = f.text; dirty = false; }
  updateCount();
  updateSelectionBtn();
  ui?.onEditorFileChange?.();
}

function updateCount() {
  if (!currentName) return;
  $('charCount').textContent = fmtChars($('editorText').value.length);
}

function updateSelectionBtn() {
  const ta = $('editorText');
  const has = !ta.hidden && ta.selectionEnd > ta.selectionStart;
  $('btnQuote').hidden = !has;
}

export async function openFile(name) {
  await flushSave();
  currentName = files.has(name) ? name : null;
  await db.kvSet('editorFile', currentName);
  renderFile();
}

// Claude の作業中は本文を触れないようにする
export function setEditorLocked(locked) {
  $('editorText').readOnly = locked;
  $('editorLock').hidden = !locked;
}

// ---------- ファイル一覧シート ----------
function openFileSheet() {
  const names = sortedNames();
  let html = '';
  let lastDir = null;
  for (const n of names) {
    const i = n.lastIndexOf('/');
    const dir = i >= 0 ? n.slice(0, i) : '';
    if (dir !== lastDir) { if (dir) html += `<div class="file-dir">${ui.esc(dir)}/</div>`; lastDir = dir; }
    const f = files.get(n);
    html += `<button class="file-item${n === currentName ? ' active' : ''}" data-name="${ui.esc(n)}">
      <span class="${dir ? 'indent' : ''}">${ui.esc(i >= 0 ? n.slice(i + 1) : n)}</span><small>${fmtChars(f.text.length)}</small></button>`;
  }
  $('fileList').innerHTML = html || '<div class="file-dir">ファイルはまだありません</div>';
  $('fileSheetScrim').hidden = false;
  $('fileSheet').classList.add('open');
}
function closeFileSheet() { $('fileSheetScrim').hidden = true; $('fileSheet').classList.remove('open'); }

// ---------- ファイル操作 ----------
function validName(name) {
  if (!name || name.length > 80 || /[\u0000-\u001f<>:"|?*]/.test(name)) return '名前は80文字以内で、<>:"|?* は使えません';
  return null;
}

async function askName(title, initial) {
  const r = await ui.dialog({ message: title, input: initial, buttons: [
    { label: 'OK', value: 'ok', cls: 'primary' }, { label: 'キャンセル', value: null },
  ] });
  if (r !== 'ok') return null;
  const name = normName($('dialogInput').value);
  const bad = validName(name);
  if (bad) { ui.toast(bad); return null; }
  return name;
}

export async function newFile(initialText = '') {
  await flushSave();
  const name = await askName('新しいファイルの名前', '');
  if (!name) return;
  if (files.has(name)) { ui.toast('同じ名前のファイルがあります'); return; }
  files.set(name, { name, text: initialText, updated: Date.now() });
  await persist(name);
  await openFile(name);
  ui.toast('作りました');
}

async function renameFile() {
  if (!currentName) return;
  await flushSave();
  const old = currentName;
  const name = await askName('新しい名前', old);
  if (!name || name === old) return;
  if (files.has(name)) { ui.toast('同じ名前のファイルがあります'); return; }
  const f = files.get(old);
  files.delete(old);
  files.set(name, { ...f, name });
  await db.fileDel(old);
  await persist(name);
  // 版と確認待ちも付け替える
  for (const v of await db.versionsOf(old)) { v.file = name; await db.versionPut(v); }
  for (const c of pending) if (c.file === old) { c.file = name; await db.changePut(c); }
  await openFile(name);
  renderPendingBar();
}

async function deleteFile() {
  if (!currentName) return;
  const name = currentName;
  const ok = await ui.dialog({ message: `「${name}」を削除しますか？\n版履歴も一緒に消えます。`, buttons: [
    { label: '削除する', value: true, cls: 'danger' }, { label: 'キャンセル', value: false },
  ] });
  if (!ok) return;
  files.delete(name);
  await db.fileDel(name);
  for (const v of await db.versionsOf(name)) await db.versionDel(v.id);
  for (const c of pending.filter((x) => x.file === name)) await db.changeDel(c.id);
  pending = pending.filter((x) => x.file !== name);
  currentName = sortedNames()[0] || null;
  await db.kvSet('editorFile', currentName);
  renderFile();
  renderPendingBar();
  ui.toast('削除しました');
}

async function copyAll() {
  if (!currentName) return;
  await flushSave();
  await navigator.clipboard.writeText(files.get(currentName).text);
  ui.toast('全文をコピーしました');
}

function download(filename, text, type = 'text/plain') {
  const blob = new Blob([text], { type: type + ';charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function saveTxt() {
  if (!currentName) return;
  await flushSave();
  download(currentName.replace(/\//g, '_') + '.txt', files.get(currentName).text);
  ui.toast('ダウンロードに保存しました');
}

async function importFiles(fileList) {
  await flushSave();
  let n = 0, last = null;
  for (const f of fileList) {
    let name = normName(f.name.replace(/\.(txt|md|text)$/i, ''));
    if (validName(name)) name = 'ファイル' + (files.size + 1);
    if (files.has(name)) {
      const r = await ui.dialog({ message: `「${name}」は既にあります。`, buttons: [
        { label: '上書きする', value: 'over', cls: 'danger' }, { label: '別名で取り込む', value: 'alt' }, { label: 'スキップ', value: null },
      ] });
      if (!r) continue;
      if (r === 'over') await autoVersion(name, '取り込みで上書き');
      else { let k = 2; while (files.has(`${name} (${k})`)) k++; name = `${name} (${k})`; }
    }
    const text = (await f.text()).replace(/\r\n?/g, '\n');
    files.set(name, { name, text, updated: Date.now() });
    await persist(name);
    n++; last = name;
  }
  if (last) await openFile(last);
  ui.toast(`${n}件を取り込みました`);
}

// ---------- 検索（本文内） ----------
let lastFind = '';
async function findInFile() {
  if (!currentName) return;
  const r = await ui.dialog({ message: '本文を検索', input: lastFind, buttons: [
    { label: '次を探す', value: 'ok', cls: 'primary' }, { label: '閉じる', value: null },
  ] });
  if (r !== 'ok') return;
  const q = $('dialogInput').value;
  if (!q) return;
  lastFind = q;
  const ta = $('editorText');
  const from = ta.selectionEnd || 0;
  let i = ta.value.indexOf(q, from);
  if (i < 0) i = ta.value.indexOf(q);
  if (i < 0) { ui.toast('見つかりません'); return; }
  selectRange(i, i + q.length);
  findInFile();
}

function selectRange(start, end) {
  const ta = $('editorText');
  ta.focus();
  ta.setSelectionRange(start, end);
  // 選択位置まで見えるようにスクロールする（行の高さから概算）
  const lh = parseFloat(getComputedStyle(ta).lineHeight) || 24;
  const linesBefore = ta.value.slice(0, start).split('\n').length - 1;
  ta.scrollTop = Math.max(0, linesBefore * lh - ta.clientHeight / 3);
  updateSelectionBtn();
}

// ---------- 選択範囲を会話に送る ----------
function quoteSelection() {
  const ta = $('editorText');
  const s = ta.selectionStart, e = ta.selectionEnd;
  if (e <= s || !currentName) return;
  const sel = ta.value.slice(s, e);
  const l1 = ta.value.slice(0, s).split('\n').length;
  const l2 = ta.value.slice(0, e).split('\n').length;
  const where = l1 === l2 ? `${l1}行目` : `${l1}〜${l2}行目`;
  const quote = `「${currentName}」の${where}:\n> ${sel.replace(/\n/g, '\n> ')}\n\n`;
  ui.sendQuote(quote);
}

// ---------- 版 ----------
async function autoVersion(name, note) {
  const f = files.get(name);
  if (!f) return;
  await db.versionPut({ id: newId(), file: name, at: Date.now(), text: f.text, kind: 'auto', note: note || '' });
  // 自動版は上限を超えた古いものから消す
  const vs = (await db.versionsOf(name)).filter((v) => v.kind === 'auto').sort((a, b) => a.at - b.at);
  for (const v of vs.slice(0, Math.max(0, vs.length - AUTO_VERSIONS_MAX))) await db.versionDel(v.id);
}

async function manualVersion() {
  if (!currentName) return;
  await flushSave();
  const r = await ui.dialog({ message: '版のメモ（空でも可）', input: '', buttons: [
    { label: '保存', value: 'ok', cls: 'primary' }, { label: 'キャンセル', value: null },
  ] });
  if (r !== 'ok') return;
  const f = files.get(currentName);
  await db.versionPut({ id: newId(), file: currentName, at: Date.now(), text: f.text, kind: 'manual', note: $('dialogInput').value.trim() });
  ui.toast('版を保存しました');
}

const fmtDate = (t) => {
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

async function openVersions() {
  if (!currentName) return;
  await flushSave();
  const vs = (await db.versionsOf(currentName)).sort((a, b) => b.at - a.at);
  const cur = files.get(currentName).text;
  $('versionsTitle').textContent = `版履歴: ${currentName}`;
  $('versionList').innerHTML = vs.length ? vs.map((v) => `
    <div class="version-item" data-id="${v.id}">
      <div class="version-head">
        <span>${fmtDate(v.at)}　${v.kind === 'manual' ? '手動' : '自動'}　${fmtChars(v.text.length)}${v.text === cur ? '　（今と同じ）' : ''}</span>
      </div>
      ${v.note ? `<div class="muted small">${ui.esc(v.note)}</div>` : ''}
      <div class="row"><button class="btn" data-act="diff">差分を見る</button><button class="btn" data-act="restore">この版に戻す</button></div>
      <div class="version-diff" hidden></div>
    </div>`).join('') : '<div class="muted">まだ版はありません。Claudeが編集する直前に自動で保存されます。</div>';
  $('versionList').onclick = async (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const item = b.closest('.version-item');
    const v = vs.find((x) => x.id === item.dataset.id);
    if (!v) return;
    if (b.dataset.act === 'diff') {
      const box = item.querySelector('.version-diff');
      if (!box.hidden) { box.hidden = true; return; }
      box.innerHTML = renderLineDiff(v.text, files.get(currentName).text);
      box.hidden = false;
    } else {
      const ok = await ui.dialog({ message: `${fmtDate(v.at)} の版に戻しますか？\n今の本文は自動で版として残します。`, buttons: [
        { label: '戻す', value: true, cls: 'primary' }, { label: 'キャンセル', value: false },
      ] });
      if (!ok) return;
      await autoVersion(currentName, '版に戻す前');
      await setText(currentName, v.text);
      ui.toast('戻しました');
      $('versions').classList.remove('open');
    }
  };
  $('versions').classList.add('open');
}

// 行（段落）単位の差分を HTML にする。長い時は変化のある行だけ出す
function renderLineDiff(a, b) {
  const parts = diffLines(a, b);
  if (parts.every((p) => !p.added && !p.removed)) return '<div class="muted">違いはありません</div>';
  let html = '';
  for (const p of parts) {
    const lines = p.value.replace(/\n$/, '').split('\n');
    if (!p.added && !p.removed) {
      if (lines.length > 2) html += `<div class="d-same">${ui.esc(lines[0])}</div><div class="d-skip">…${lines.length - 2}行…</div><div class="d-same">${ui.esc(lines[lines.length - 1])}</div>`;
      else html += lines.map((l) => `<div class="d-same">${ui.esc(l)}</div>`).join('');
    } else {
      html += lines.map((l) => `<div class="${p.added ? 'd-add' : 'd-del'}">${ui.esc(l)}</div>`).join('');
    }
  }
  return html;
}

// 置換前後の差分（文字単位で変わったところを濃く）
function renderCharDiff(oldS, newS) {
  const parts = diffChars(oldS, newS);
  const del = parts.filter((p) => !p.added).map((p) => p.removed ? `<mark>${ui.esc(p.value)}</mark>` : ui.esc(p.value)).join('');
  const add = parts.filter((p) => !p.removed).map((p) => p.added ? `<mark>${ui.esc(p.value)}</mark>` : ui.esc(p.value)).join('');
  return `<div class="d-del">${del || '（なし）'}</div><div class="d-add">${add || '（なし）'}</div>`;
}

// ---------- Claude のツールから呼ばれる書き換え ----------
export function beginToolTurn() { versionedThisTurn = new Set(); }

async function applyEdit(name, oldS, newS, convId) {
  await flushSave();
  if (!versionedThisTurn.has(name)) { await autoVersion(name, 'Claudeの編集前'); versionedThisTurn.add(name); }
  const f = files.get(name);
  const i = f.text.indexOf(oldS);
  await setText(name, f.text.slice(0, i) + newS + f.text.slice(i + oldS.length));
  const c = { id: newId(), file: name, kind: 'edit', old: oldS, new: newS, at: Date.now(), convId };
  pending.unshift(c);
  await db.changePut(c);
  renderPendingBar();
}

async function createFile(name, text, convId) {
  await flushSave();
  files.set(name, { name, text, updated: Date.now() });
  await persist(name);
  const c = { id: newId(), file: name, kind: 'write', old: '', new: text, at: Date.now(), convId };
  pending.unshift(c);
  await db.changePut(c);
  if (!currentName) await openFile(name);
  renderPendingBar();
}

// app.js の送信ループから呼ぶ。readFiles はその会話で読んだファイル名の Set
export async function runTool(name, input, { readFiles, convId }) {
  await flushSave();
  const ctx = {
    getText: (n) => files.get(n)?.text,
    names: sortedNames,
    readFiles,
    applyEdit: (n, o, w) => applyEdit(n, o, w, convId),
    createFile: (n, t) => createFile(n, t, convId),
  };
  return runToolCore(name, input, ctx);
}

export function toolDefs() { return TOOL_DEFS; }

// 編集所の会話に付けるシステムプロンプト（固定文とファイル一覧）
export function systemExtras() {
  const list = sortedNames().map((n) => files.get(n));
  return [TOOL_RULES, '## ファイル一覧\n' + fileListText(list)];
}

// ---------- 変更の確認（反映／差し戻し） ----------
function renderPendingBar() {
  const n = pending.length;
  $('pendingBar').hidden = n === 0;
  $('pendingCount').textContent = n;
  ui?.onPendingChange?.(n);
}

export function openReview(changeId) {
  if (!pending.length) return;
  reviewIndex = Math.max(0, pending.findIndex((c) => c.id === changeId));
  renderReview();
  $('reviewScrim').hidden = false;
  $('reviewSheet').classList.add('open');
}
function closeReview() { $('reviewScrim').hidden = true; $('reviewSheet').classList.remove('open'); }

function renderReview() {
  if (!pending.length) { closeReview(); return; }
  if (reviewIndex >= pending.length) reviewIndex = pending.length - 1;
  const c = pending[reviewIndex];
  $('reviewTitle').textContent = `${c.file}　${reviewIndex + 1}/${pending.length}件`;
  $('reviewSub').textContent = c.kind === 'write' ? '新しいファイル' : fmtDate(c.at);
  $('reviewDiff').innerHTML = c.kind === 'write'
    ? `<div class="d-add">${ui.esc(c.new.length > 600 ? c.new.slice(0, 600) + '…' : c.new)}</div>`
    : renderCharDiff(c.old, c.new);
  $('btnReviewPrev').disabled = reviewIndex === 0;
  $('btnReviewNext').disabled = reviewIndex >= pending.length - 1;
}

async function acceptChange(c) {
  pending = pending.filter((x) => x !== c);
  await db.changeDel(c.id);
}

// 差し戻し。置換後の文字列が本文に1箇所だけあれば逆置換する
async function revertChange(c) {
  await flushSave();
  const f = files.get(c.file);
  if (!f) { await acceptChange(c); return '対象のファイルがもうありません。記録だけ消しました。'; }
  if (c.kind === 'write') {
    if (f.text !== c.new) return 'このファイルは作られた後に変わっています。削除するなら ⋮ メニューから手動で削除してください。';
    files.delete(c.file);
    await db.fileDel(c.file);
    if (currentName === c.file) { currentName = sortedNames()[0] || null; await db.kvSet('editorFile', currentName); renderFile(); }
    await acceptChange(c);
    return null;
  }
  let n = 0, i = 0;
  while ((i = f.text.indexOf(c.new, i)) !== -1) { n++; i += c.new.length; if (n > 1) break; }
  if (n !== 1) {
    return (n === 0 ? '置き換え後の文が本文に見つかりません。' : '置き換え後の文が本文に複数あります。')
      + '後の変更と重なっているか、手で直した後のようです。必要なら本文を手で戻してください。\n\n元の文:\n' + c.old;
  }
  const pos = f.text.indexOf(c.new);
  await setText(c.file, f.text.slice(0, pos) + c.old + f.text.slice(pos + c.new.length));
  await acceptChange(c);
  return null;
}

async function jumpToChange(c) {
  if (!files.has(c.file)) return;
  if (currentName !== c.file) await openFile(c.file);
  ui.showEditorTab?.();
  const pos = files.get(c.file).text.indexOf(c.new);
  if (pos >= 0) selectRange(pos, pos + c.new.length);
  else ui.toast('本文にこの箇所が見つかりません');
}

// 会話タブのカードから: ファイルと置換後の文で該当箇所へ飛ぶ
export async function jumpTo(file, text) {
  const name = normName(file);
  if (!files.has(name)) { ui.toast('そのファイルはもうありません'); return; }
  if (currentName !== name) await openFile(name);
  ui.showEditorTab?.();
  const pos = text ? files.get(name).text.indexOf(text) : -1;
  if (pos >= 0) selectRange(pos, pos + text.length);
  else selectRange(0, 0);
}

// ---------- バックアップ ----------
export async function makeBackup(convs, settings) {
  await flushSave();
  const { systemPrompt, editSystemPrompt, defModel, defThink, editModel, editThink, theme, yenRate, budget } = settings;
  const data = {
    app: 'AIChat', format: 2, exportedAt: new Date().toISOString(),
    conversations: convs,
    files: [...files.values()],
    changes: pending,
    versions: await db.versionAll(),
    settings: { systemPrompt, editSystemPrompt, defModel, defThink, editModel, editThink, theme, yenRate, budget },
  };
  const d = new Date();
  download(`AIChat_バックアップ_${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.json`, JSON.stringify(data), 'application/json');
  await db.kvSet('lastBackup', Date.now());
  ui.toast('ダウンロードに保存しました');
}

// 復元。会話の取り込みは app.js 側（importConvs）に任せ、ここではファイル・変更・版を戻す
export async function restoreBackup(file, importConvs, applySettings) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { ui.toast('ファイルが読めません'); return; }
  if (data.app !== 'AIChat') { ui.toast('AIChatのバックアップではありません'); return; }
  const nf = (data.files || []).length, nc = (data.conversations || []).length;
  const when = data.exportedAt ? fmtDate(Date.parse(data.exportedAt)) : '不明';
  const ok = await ui.dialog({ message: `バックアップ（${when}）\nファイル ${nf}件・会話 ${nc}件\n\n復元しますか？ 同じものは新しい方を残します。`, buttons: [
    { label: '復元する', value: true, cls: 'primary' }, { label: 'キャンセル', value: false },
  ] });
  if (!ok) return;
  await flushSave();
  let n = 0;
  for (const f of data.files || []) {
    if (!f.name || typeof f.text !== 'string') continue;
    const old = files.get(f.name);
    if (old && old.updated >= (f.updated || 0)) continue;
    files.set(f.name, { name: f.name, text: f.text, updated: f.updated || Date.now() });
    await persist(f.name);
    n++;
  }
  for (const v of data.versions || []) if (v.id && v.file && typeof v.text === 'string') await db.versionPut(v);
  for (const c of data.changes || []) {
    if (!c.id || !c.file || pending.some((x) => x.id === c.id)) continue;
    pending.push(c);
    await db.changePut(c);
  }
  pending.sort((a, b) => b.at - a.at);
  const nconv = importConvs ? await importConvs(data.conversations || []) : 0;
  if (data.settings && applySettings) await applySettings(data.settings);
  if (!currentName) currentName = sortedNames()[0] || null;
  renderFile();
  renderPendingBar();
  ui.toast(`ファイル${n}件・会話${nconv}件を復元しました`);
}

export async function lastBackupText() {
  const t = await db.kvGet('lastBackup');
  if (!t) return 'まだバックアップしていません';
  const days = Math.floor((Date.now() - t) / 864e5);
  return `最終バックアップ: ${days === 0 ? '今日' : days + '日前'}`;
}

export async function backupIsOld() {
  if (!files.size) return false;
  const t = await db.kvGet('lastBackup');
  return !t || Date.now() - t > 7 * 864e5;
}

// ---------- ⋮ メニュー ----------
async function openMenu() {
  const has = !!currentName;
  const items = [
    { label: '新しいファイル', value: 'new' },
    { label: '取り込み（.txt / .md）', value: 'import' },
    has && { label: '検索', value: 'find' },
    has && { label: '版を保存', value: 'version' },
    has && { label: '版履歴', value: 'versions' },
    has && { label: '全文コピー', value: 'copy' },
    has && { label: '.txtで保存', value: 'txt' },
    has && { label: '名前を変更', value: 'rename' },
    has && { label: '削除', value: 'delete', cls: 'danger' },
    { label: 'バックアップを保存', value: 'backup' },
    { label: 'バックアップから復元', value: 'restore' },
    { label: '閉じる', value: null },
  ].filter(Boolean);
  const act = await ui.dialog({ message: (currentName || '編集所') + '\n' + await lastBackupText(), buttons: items });
  switch (act) {
    case 'new': return newFile();
    case 'import': return $('importTxt').click();
    case 'find': return findInFile();
    case 'version': return manualVersion();
    case 'versions': return openVersions();
    case 'copy': return copyAll();
    case 'txt': return saveTxt();
    case 'rename': return renameFile();
    case 'delete': return deleteFile();
    case 'backup': return ui.backup();
    case 'restore': return $('restoreFile').click();
  }
}

// ---------- イベント ----------
function bind() {
  const ta = $('editorText');
  ta.addEventListener('input', () => { scheduleSave(); updateCount(); });
  ta.addEventListener('blur', flushSave);
  document.addEventListener('selectionchange', () => { if (document.activeElement === ta) updateSelectionBtn(); });
  ta.addEventListener('keyup', updateSelectionBtn);
  ta.addEventListener('pointerup', updateSelectionBtn);
  window.addEventListener('pagehide', flushSave);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSave(); });

  $('btnFile').onclick = openFileSheet;
  $('fileSheetScrim').onclick = closeFileSheet;
  $('fileList').onclick = (e) => {
    const b = e.target.closest('.file-item');
    if (!b) return;
    closeFileSheet();
    openFile(b.dataset.name);
  };
  $('btnFileNew').onclick = () => { closeFileSheet(); newFile(); };
  $('btnEditorMenu').onclick = openMenu;
  $('btnEmptyNew').onclick = () => newFile();
  $('btnEmptyImport').onclick = () => $('importTxt').click();
  $('btnEmptyPaste').onclick = async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (!t) { ui.toast('クリップボードが空です'); return; }
      newFile(t.replace(/\r\n?/g, '\n'));
    } catch { ui.toast('貼り付けできませんでした。新しいファイルを作って本文に貼ってください'); }
  };
  $('importTxt').onchange = (e) => { importFiles([...e.target.files]); e.target.value = ''; };
  $('restoreFile').onchange = (e) => { const f = e.target.files[0]; if (f) ui.restore(f); e.target.value = ''; };
  $('btnQuote').onclick = quoteSelection;
  $('btnVersionsClose').onclick = () => $('versions').classList.remove('open');

  // 変更の確認
  $('pendingBar').onclick = () => openReview();
  $('reviewScrim').onclick = closeReview;
  $('btnReviewPrev').onclick = () => { reviewIndex--; renderReview(); };
  $('btnReviewNext').onclick = () => { reviewIndex++; renderReview(); };
  $('btnReviewJump').onclick = () => { const c = pending[reviewIndex]; closeReview(); if (c) jumpToChange(c); };
  $('btnReviewAccept').onclick = async () => {
    const c = pending[reviewIndex];
    if (!c) return;
    await acceptChange(c);
    renderPendingBar();
    renderReview();
  };
  $('btnReviewRevert').onclick = async () => {
    const c = pending[reviewIndex];
    if (!c) return;
    const msg = await revertChange(c);
    if (msg) await ui.dialog({ message: msg, buttons: [{ label: 'OK', value: true, cls: 'primary' }] });
    else ui.toast('差し戻しました');
    renderPendingBar();
    renderReview();
  };
  $('btnReviewAcceptAll').onclick = async () => {
    const ok = await ui.dialog({ message: `${pending.length}件すべて反映しますか？`, buttons: [
      { label: '全て反映', value: true, cls: 'primary' }, { label: 'キャンセル', value: false },
    ] });
    if (!ok) return;
    for (const c of [...pending]) await acceptChange(c);
    renderPendingBar();
    closeReview();
    ui.toast('すべて反映しました');
  };
}
