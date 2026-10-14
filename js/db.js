// IndexedDB の薄いラッパー
// ストア: kv（設定・集計などのキー値）/ convs（会話）/ files（編集所のファイル）/ versions（版）/ changes（確認待ちの変更）

const DB_NAME = 'aichat';
const DB_VER = 2;
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('convs')) db.createObjectStore('convs', { keyPath: 'id' });
      // v2: 編集所
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'name' });
      if (!db.objectStoreNames.contains('versions')) {
        const vs = db.createObjectStore('versions', { keyPath: 'id' });
        vs.createIndex('file', 'file', { unique: false });
      }
      if (!db.objectStoreNames.contains('changes')) db.createObjectStore('changes', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

// 1回分のトランザクションを Promise で包む
async function run(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const kvGet = (key) => run('kv', 'readonly', (s) => s.get(key));
export const kvSet = (key, val) => run('kv', 'readwrite', (s) => s.put(val, key));
export const kvDel = (key) => run('kv', 'readwrite', (s) => s.delete(key));

export const convGet = (id) => run('convs', 'readonly', (s) => s.get(id));
export const convPut = (conv) => run('convs', 'readwrite', (s) => s.put(conv));
export const convDel = (id) => run('convs', 'readwrite', (s) => s.delete(id));
export const convAll = () => run('convs', 'readonly', (s) => s.getAll());

// 編集所のファイル { name, text, updated }
export const fileGet = (name) => run('files', 'readonly', (s) => s.get(name));
export const filePut = (f) => run('files', 'readwrite', (s) => s.put(f));
export const fileDel = (name) => run('files', 'readwrite', (s) => s.delete(name));
export const fileAll = () => run('files', 'readonly', (s) => s.getAll());

// 版 { id, file, at, text, kind: 'auto'|'manual', note }
export const versionPut = (v) => run('versions', 'readwrite', (s) => s.put(v));
export const versionDel = (id) => run('versions', 'readwrite', (s) => s.delete(id));
export const versionAll = () => run('versions', 'readonly', (s) => s.getAll());
export const versionsOf = (file) => run('versions', 'readonly', (s) => s.index('file').getAll(file));

// 確認待ちの変更 { id, file, kind: 'edit'|'write', old, new, at, convId }
export const changePut = (c) => run('changes', 'readwrite', (s) => s.put(c));
export const changeDel = (id) => run('changes', 'readwrite', (s) => s.delete(id));
export const changeAll = () => run('changes', 'readonly', (s) => s.getAll());

// 端末のストレージ整理で消されないよう永続化を要求する（Android Chrome向け）
export async function requestPersist() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      if (!(await navigator.storage.persisted())) await navigator.storage.persist();
    }
  } catch (e) { /* 非対応ブラウザは無視 */ }
}

// 使用量の目安 { usage, quota }（取れない時は null）
export async function storageEstimate() {
  try { return navigator.storage?.estimate ? await navigator.storage.estimate() : null; } catch { return null; }
}
