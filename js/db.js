/* 여백 — 저장소 (IndexedDB, 실패 시 메모리 대체) */
const DB = (() => {
  'use strict';

  const DB_NAME = 'yeobaeck';
  const DB_VERSION = 1;
  const STORE = 'notes';

  let db = null;
  let mem = null;        // IndexedDB를 못 쓸 때의 임시 저장소
  let promoteCb = null;  // 뒤늦게 IndexedDB가 열렸을 때 앱에 알리는 길

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
      req.onsuccess = async (e) => {
        const opened = e.target.result;
        opened.onversionchange = () => opened.close();
        if (settled) {
          // 타임아웃 뒤에야 열렸다 — 메모리에 쌓인 기록을 옮기고 승격한다
          const pending = mem ? [...mem.values()] : [];
          db = opened;
          mem = null;
          try {
            if (pending.length) await bulkPut(pending);
          } catch (err) { /* 옮기다 실패해도 DB 자체는 살린다 */ }
          if (promoteCb) promoteCb();
          return;
        }
        settled = true;
        db = opened;
        resolve(true);
      };
      req.onerror = fallback;
      req.onblocked = fallback;
      // 일부 사생활 보호 모드에서 open이 영영 답하지 않는 경우 대비
      setTimeout(fallback, 4000);
    });
  }

  const persistent = () => !!db;

  /** 뒤늦은 IndexedDB 연결 승격을 통지받을 콜백 등록 */
  function onPromote(cb) { promoteCb = cb; }

  function wrap(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * 쓰기 작업은 요청 성공이 아니라 트랜잭션 커밋까지 확인한다.
   * (용량 초과 등은 커밋 시점에 abort로 나타나므로, 요청 성공만 믿으면
   *  "저장됨"이라 말해 놓고 실제로는 사라지는 참사가 난다.)
   */
  function writeTx(fn) {
    return new Promise((resolve, reject) => {
      let t;
      try {
        t = db.transaction(STORE, 'readwrite');
      } catch (e) {
        return reject(e);
      }
      try {
        fn(t.objectStore(STORE));
      } catch (e) {
        return reject(e);
      }
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('transaction aborted'));
    });
  }

  async function getAll() {
    if (mem) return [...mem.values()];
    return wrap(db.transaction(STORE, 'readonly').objectStore(STORE).getAll());
  }

  async function get(id) {
    if (mem) return mem.get(id) || null;
    return wrap(db.transaction(STORE, 'readonly').objectStore(STORE).get(id));
  }

  async function put(note) {
    if (mem) { mem.set(note.id, note); return; }
    return writeTx(s => s.put(note));
  }

  async function del(id) {
    if (mem) { mem.delete(id); return; }
    return writeTx(s => s.delete(id));
  }

  async function bulkPut(notes) {
    if (mem) { notes.forEach(n => mem.set(n.id, n)); return; }
    return writeTx(s => notes.forEach(n => s.put(n)));
  }

  return { open, persistent, onPromote, getAll, get, put, del, bulkPut };
})();
