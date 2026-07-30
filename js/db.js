/* 여백 — 저장소 (IndexedDB, 실패 시 메모리 대체) */
const DB = (() => {
  'use strict';

  const DB_NAME = 'yeobaeck';
  const DB_VERSION = 1;
  const STORE = 'notes';

  let db = null;
  let mem = null; // IndexedDB를 못 쓸 때의 임시 저장소

  function open() {
    return new Promise((resolve) => {
      let settled = false;
      const fallback = () => {
        if (settled) return;
        settled = true;
        mem = new Map();
        resolve(false);
      };

      if (!window.indexedDB) return fallback();

      let req;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (e) {
        return fallback();
      }

      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains(STORE)) {
          const store = d.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('updatedAt', 'updatedAt');
        }
      };
      req.onsuccess = (e) => {
        if (settled) return;
        settled = true;
        db = e.target.result;
        db.onversionchange = () => db.close();
        resolve(true);
      };
      req.onerror = fallback;
      req.onblocked = fallback;
      // 일부 사생활 보호 모드에서 open이 영영 답하지 않는 경우 대비
      setTimeout(fallback, 4000);
    });
  }

  const persistent = () => !!db;

  function store(mode) {
    return db.transaction(STORE, mode).objectStore(STORE);
  }

  function wrap(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function getAll() {
    if (mem) return [...mem.values()];
    return wrap(store('readonly').getAll());
  }

  async function get(id) {
    if (mem) return mem.get(id) || null;
    return wrap(store('readonly').get(id));
  }

  async function put(note) {
    if (mem) { mem.set(note.id, note); return; }
    return wrap(store('readwrite').put(note));
  }

  async function del(id) {
    if (mem) { mem.delete(id); return; }
    return wrap(store('readwrite').delete(id));
  }

  async function bulkPut(notes) {
    if (mem) { notes.forEach(n => mem.set(n.id, n)); return; }
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, 'readwrite');
      const s = t.objectStore(STORE);
      notes.forEach(n => s.put(n));
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  return { open, persistent, getAll, get, put, del, bulkPut };
})();
