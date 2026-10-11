// IndexedDB の薄いラッパー
// ストアは2つ: kv（設定・集計などのキー値）と convs（会話）

const DB_NAME = 'aichat';
const DB_VER = 1;
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('convs')) db.createObjectStore('convs', { keyPath: 'id' });
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

// 端末のストレージ整理で消されないよう永続化を要求する（Android Chrome向け）
export async function requestPersist() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      if (!(await navigator.storage.persisted())) await navigator.storage.persist();
    }
  } catch (e) { /* 非対応ブラウザは無視 */ }
}
