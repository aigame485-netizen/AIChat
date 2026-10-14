// 編集所のツール（Claude Code の Read / Edit / Write / Grep / List に準じた自作版）
// 定義（JSON Schema）・入力の検証・実行をここに置く。ファイルの読み書きは ctx 経由で行う

const READ_MAX_CHARS = 30000;   // read 1回で返す文字数の上限
const READ_DEFAULT_LINES = 2000;
const GREP_MAX_HITS = 50;
const GREP_CONTEXT = 120;       // 一致した行が長い時、前後に残す文字数

const str = (desc) => ({ type: 'string', description: desc });
const int = (desc) => ({ type: 'integer', description: desc });
const schema = (props, required) => ({ type: 'object', properties: props, required, additionalProperties: false });

export const TOOL_DEFS = [
  {
    name: 'list',
    description: 'ファイルの一覧（名前と文字数）を返す。',
    input_schema: schema({}, []),
    strict: true,
  },
  {
    name: 'read',
    description: [
      'ファイルを行番号付きで読む。offset（開始行、1始まり）と limit（行数）で範囲を指定できる。',
      `省略すると先頭から${READ_DEFAULT_LINES}行。1回で返せる文字数には上限があり、超えた時は途中で切って続きの offset を伝える。`,
      '長いファイルは grep で場所を探してから行範囲で読む。',
    ].join(''),
    input_schema: schema({ file: str('ファイル名'), offset: int('開始行（1始まり）。省略時は1'), limit: int('読む行数。省略時は' + READ_DEFAULT_LINES) }, ['file']),
    strict: true,
  },
  {
    name: 'grep',
    description: 'ファイルの中から正規表現に一致する行を探す。file を省略すると全ファイルを探す。一致した行のファイル名・行番号・内容を返す。',
    input_schema: schema({ pattern: str('正規表現（JavaScript の RegExp）'), file: str('探すファイル名。省略時は全ファイル') }, ['pattern']),
    strict: true,
  },
  {
    name: 'edit',
    description: [
      'ファイルの一部を置き換える。old_string は本文に1箇所だけ一致する必要がある（前後の文を含めて一意にする）。',
      '先に read で読んだファイルにしか使えない。',
      '編集はすぐ本文に反映されるが、利用者があとで1件ずつ確認し、気に入らなければ差し戻すことがある。',
      '1件の編集は小さく自己完結にし、同じ箇所を何度も直さない。改行や空白も含めて正確に一致させること。',
    ].join(''),
    input_schema: schema({ file: str('ファイル名'), old_string: str('置き換える前の文（本文に1箇所だけ一致すること）'), new_string: str('置き換えた後の文') }, ['file', 'old_string', 'new_string']),
    strict: true,
    eager_input_streaming: true,
  },
  {
    name: 'write',
    description: '新しいファイルを作る。既にあるファイル名には使えない（既存のファイルは edit で直す）。利用者があとで確認し、差し戻す（削除する）ことがある。',
    input_schema: schema({ file: str('ファイル名（例: 第2章、設定/登場人物）'), content: str('本文') }, ['file', 'content']),
    strict: true,
    eager_input_streaming: true,
  },
];

export const TOOL_NAMES = new Set(TOOL_DEFS.map((t) => t.name));

// ツールの約束事（システムプロンプトに固定文として入れる）
export const TOOL_RULES = [
  'ここは「編集所」です。利用者の文章はファイルとして置かれており、ツールで読み書きします。',
  '- ファイルの中身は会話に貼られていません。内容が必要な時は read で読んでください',
  '- 大きいファイルは grep で場所を探し、read の offset / limit で必要な範囲だけ読む',
  '- 編集は edit を使い、置き換える前の文（old_string）は前後を含めて1箇所に特定できる長さにする',
  '- 編集はすぐ反映されますが、利用者が1件ずつ確認して差し戻すことがあります。1件を小さく自己完結にし、同じ箇所を何度も直さない',
  '- 新しいファイルは write で作る。既存ファイルの上書きはできない',
  '- 文章の書き換えを頼まれていない時（感想・相談・質問）は読むだけにして、勝手に編集しない',
  '- 編集したら、何をどう変えたかを短く報告する',
].join('\n');

// ---------- 入力の検証（eager_input_streaming では API が検証しないため自前で行う） ----------
function validate(name, input) {
  const def = TOOL_DEFS.find((t) => t.name === name);
  if (!def) return `不明なツール: ${name}`;
  if (!input || typeof input !== 'object') return '入力がオブジェクトではありません';
  const props = def.input_schema.properties;
  for (const k of def.input_schema.required) if (!(k in input)) return `${k} がありません`;
  for (const [k, v] of Object.entries(input)) {
    const p = props[k];
    if (!p) return `不明な項目: ${k}`;
    if (p.type === 'string' && typeof v !== 'string') return `${k} は文字列にしてください`;
    if (p.type === 'integer' && !(Number.isInteger(v) && v >= 0)) return `${k} は0以上の整数にしてください`;
  }
  return null;
}

// 文字数の概数（ファイル一覧用。細かく変わってキャッシュを壊さないよう丸める）
export function roughChars(n) {
  if (n < 1000) return `約${Math.max(100, Math.round(n / 100) * 100)}字`;
  if (n < 10000) return `約${(Math.round(n / 100) / 10).toFixed(1).replace(/\.0$/, '')}千字`;
  return `約${(Math.round(n / 1000) / 10).toFixed(1).replace(/\.0$/, '')}万字`;
}

// ファイル一覧の文章（システムプロンプト用）
export function fileListText(files) {
  if (!files.length) return 'ファイルはまだありません。';
  return files.map((f) => `- ${f.name}（${roughChars(f.text.length)}）`).join('\n');
}

export const normName = (s) => String(s).trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');

// ---------- 実行 ----------
// ctx: { getText(name) → string|undefined, names() → string[], readFiles: Set,
//        applyEdit(name, oldS, newS) → Promise, createFile(name, text) → Promise }
// 戻り値: { content: string, is_error?: true }
export async function runTool(name, input, ctx) {
  const bad = validate(name, input);
  if (bad) return { content: `入力が正しくありません: ${bad}`, is_error: true };
  try {
    switch (name) {
      case 'list': return { content: listTool(ctx) };
      case 'read': return readTool(input, ctx);
      case 'grep': return grepTool(input, ctx);
      case 'edit': return await editTool(input, ctx);
      case 'write': return await writeTool(input, ctx);
    }
  } catch (e) {
    return { content: `ツールの実行に失敗しました: ${e.message || e}`, is_error: true };
  }
  return { content: `不明なツール: ${name}`, is_error: true };
}

function listTool(ctx) {
  const names = ctx.names();
  if (!names.length) return 'ファイルはまだありません。';
  return names.map((n) => `${n}\t${ctx.getText(n).length}字`).join('\n');
}

function notFound(name, ctx) {
  const names = ctx.names();
  return { content: `「${name}」というファイルはありません。` + (names.length ? `あるのは: ${names.join(', ')}` : 'ファイルはまだありません。'), is_error: true };
}

function readTool({ file, offset, limit }, ctx) {
  const name = normName(file);
  const text = ctx.getText(name);
  if (text === undefined) return notFound(name, ctx);
  const lines = text.split('\n');
  const start = Math.max(1, offset || 1);
  const count = limit || READ_DEFAULT_LINES;
  if (start > lines.length) return { content: `${name} は全${lines.length}行です。offset=${start} はファイルの終わりを超えています。`, is_error: true };
  let out = '';
  let i = start;
  for (; i <= Math.min(lines.length, start + count - 1); i++) {
    const row = `${i}\t${lines[i - 1]}\n`;
    if (out.length + row.length > READ_MAX_CHARS && out) break;
    out += row;
  }
  ctx.readFiles.add(name);
  const end = i - 1;
  let tail = `\n（${name}: ${start}〜${end}行目 / 全${lines.length}行・${text.length}字）`;
  if (end < lines.length) tail += `\n続きを読むには offset=${end + 1} を指定してください。`;
  return { content: out + tail };
}

function grepTool({ pattern, file }, ctx) {
  let re;
  try { re = new RegExp(pattern, 'u'); } catch (e) { return { content: `正規表現が正しくありません: ${e.message}`, is_error: true }; }
  let targets;
  if (file) {
    const name = normName(file);
    if (ctx.getText(name) === undefined) return notFound(name, ctx);
    targets = [name];
  } else targets = ctx.names();
  const hits = [];
  let total = 0;
  for (const name of targets) {
    const lines = ctx.getText(name).split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = re.exec(lines[i]);
      if (!m) continue;
      total++;
      if (hits.length >= GREP_MAX_HITS) continue;
      let line = lines[i];
      if (line.length > GREP_CONTEXT * 2) {
        const s = Math.max(0, m.index - GREP_CONTEXT);
        line = (s > 0 ? '…' : '') + line.slice(s, m.index + m[0].length + GREP_CONTEXT) + (m.index + m[0].length + GREP_CONTEXT < line.length ? '…' : '');
      }
      hits.push(`${name}:${i + 1}: ${line}`);
    }
  }
  if (!total) return { content: '一致する行はありませんでした。' };
  let out = hits.join('\n');
  if (total > hits.length) out += `\n（${total}件中、先頭の${hits.length}件のみ表示。pattern や file で絞ってください）`;
  return { content: out };
}

function countOf(text, s) {
  if (!s) return 0;
  let n = 0, i = 0;
  while ((i = text.indexOf(s, i)) !== -1) { n++; i += s.length; if (n > 2) break; }
  return n;
}

async function editTool({ file, old_string, new_string }, ctx) {
  const name = normName(file);
  const text = ctx.getText(name);
  if (text === undefined) return notFound(name, ctx);
  if (!ctx.readFiles.has(name)) return { content: `「${name}」はまだ読んでいません。先に read で読んでから編集してください。`, is_error: true };
  if (!old_string) return { content: 'old_string が空です。置き換える前の文を指定してください。', is_error: true };
  if (old_string === new_string) return { content: 'old_string と new_string が同じです。', is_error: true };
  const n = countOf(text, old_string);
  if (n === 0) return { content: `old_string が「${name}」の本文に見つかりません。read で現在の本文を確かめ、改行や空白も含めて正確に指定してください。`, is_error: true };
  if (n > 1) return { content: `old_string が「${name}」の本文に複数箇所あります。前後の文を含めて1箇所に特定できるようにしてください。`, is_error: true };
  await ctx.applyEdit(name, old_string, new_string);
  return { content: `「${name}」を編集しました。` };
}

async function writeTool({ file, content }, ctx) {
  const name = normName(file);
  if (!name || name.length > 80 || /[\u0000-\u001f<>:"|?*]/.test(name)) return { content: 'ファイル名が使えません。80文字以内で、<>:"|?* と制御文字を含めないでください。', is_error: true };
  if (ctx.getText(name) !== undefined) return { content: `「${name}」は既にあります。既存のファイルは edit で直してください。`, is_error: true };
  await ctx.createFile(name, content);
  ctx.readFiles.add(name);
  return { content: `「${name}」を作りました（${content.length}字）。` };
}
