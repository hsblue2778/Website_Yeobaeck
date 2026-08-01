/* 여백 — 저장소 (IndexedDB, 실패 시 메모리 대체) */
const DB = (() => {
  'use strict';

  const DB_NAME = 'yeobaeck';
  const DB_VERSION = 2;
  const STORE = 'notes';
  const FILES = 'files';   // 붙임 파일 — {id, noteId, name, type, size, addedAt, blob}

  let db = null;
  let mem = null;        // IndexedDB를 못 쓸 때의 임시 저장소
  let memFiles = null;   // 같은 상황에서의 붙임 파일
  let promoteCb = null;  // 뒤늦게 IndexedDB가 열렸을 때 앱에 알리는 길
  let staleCb = null;    // 다른 탭이 판을 올려 이 연결이 낡았을 때
  let stale = false;

  /**
   * 새 설치든 옛 판(v1)이든 같은 자리에 닿도록, '있는 것만 골라' 만든다.
   * 판 번호(oldVersion)로 갈래를 타면 어중간한 상태에서 되살아나지 못한다 —
   * 빌드가 없는 정적 사이트라 이용자가 어느 판에 머물러 있을지 알 수 없다.
   * 이 안에서는 절대 await 하지 않는다(버전 트랜잭션이 먼저 닫혀 버린다).
   */
  function upgrade(d, tx) {
    if (!d.objectStoreNames.contains(STORE)) {
      const store = d.createObjectStore(STORE, { keyPath: 'id' });
      store.createIndex('updatedAt', 'updatedAt');
    }
    if (!d.objectStoreNames.contains(FILES)) {
      const files = d.createObjectStore(FILES, { keyPath: 'id' });
      files.createIndex('noteId', 'noteId');
      files.createIndex('addedAt', 'addedAt');
    } else if (tx) {
      const files = tx.objectStore(FILES);
      if (!files.indexNames.contains('noteId')) files.createIndex('noteId', 'noteId');
      if (!files.indexNames.contains('addedAt')) files.createIndex('addedAt', 'addedAt');
    }
  }

  function open() {
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const fallback = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        mem = new Map();
        memFiles = new Map();
        resolve(false);
      };

      if (!window.indexedDB) return fallback();

      let req;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (e) {
        return fallback();
      }

      req.onupgradeneeded = (e) => upgrade(e.target.result, e.target.transaction);
      req.onsuccess = async (e) => {
        const opened = e.target.result;
        // 다른 탭이 판을 올리려 하면 길을 비켜 준다. 다만 그 뒤로 이 연결은
        // 닫힌 채 truthy로 남으므로, 낡았음을 표시해 두어야 한다.
        opened.onversionchange = () => { opened.close(); stale = true; if (staleCb) staleCb(); };
        opened.onclose = () => { stale = true; if (staleCb) staleCb(); };
        if (settled) {
          // 타임아웃 뒤에야 열렸다 — 메모리에 쌓인 기록을 옮기고 승격한다
          const pending = mem ? [...mem.values()] : [];
          const pendingFiles = memFiles ? [...memFiles.values()] : [];
          db = opened;
          mem = null;
          memFiles = null;
          try {
            if (pending.length) await bulkPut(pending);
            for (const f of pendingFiles) await putFile(f);
          } catch (err) { /* 옮기다 실패해도 DB 자체는 살린다 */ }
          if (promoteCb) promoteCb();
          return;
        }
        settled = true;
        clearTimeout(timer);
        db = opened;
        resolve(true);
      };
      req.onerror = fallback;
      // 판을 올리는 중이라 막혔을 뿐이다. 여기서 메모리로 물러나면 다른 탭이
      // 비켜 준 뒤에도 기록이 텅 빈 것처럼 보인다 — 기다렸다가 다시 본다.
      req.onblocked = () => { clearTimeout(timer); timer = setTimeout(fallback, 10000); };
      // 일부 사생활 보호 모드에서 open이 영영 답하지 않는 경우 대비
      timer = setTimeout(fallback, 4000);
    });
  }

  const persistent = () => !!db && !stale;
  const isStale = () => stale;

  /** 뒤늦은 IndexedDB 연결 승격을 통지받을 콜백 등록 */
  function onPromote(cb) { promoteCb = cb; }

  /** 다른 탭이 판을 올려 이 탭이 낡았음을 통지받을 콜백 등록 */
  function onStale(cb) { staleCb = cb; }

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
   * names에 저장소를 여럿 주면 한 트랜잭션으로 묶인다 — 글과 붙임을
   * 함께 지울 때처럼 반쪽만 지워지면 안 되는 일에 쓴다.
   */
  function writeTx(names, fn) {
    return new Promise((resolve, reject) => {
      let t;
      try {
        t = db.transaction(names, 'readwrite');
      } catch (e) {
        return reject(e);
      }
      try {
        const stores = (Array.isArray(names) ? names : [names]).map(n => t.objectStore(n));
        fn(...stores);
      } catch (e) {
        return reject(e);
      }
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('transaction aborted'));
    });
  }

  /** 색인으로 훑으며 조건에 맞는 것만 모은다(커서라 한꺼번에 메모리에 안 올린다) */
  function cursorEach(store, query, fn) {
    return new Promise((resolve, reject) => {
      const req = query ? store.openCursor(query) : store.openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return resolve();
        fn(cur);
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  /* ---------- 기록 ---------- */
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
    return writeTx(STORE, s => s.put(note));
  }

  /** 글을 지울 때 그 붙임 파일도 한 트랜잭션 안에서 함께 지운다 */
  async function del(id) {
    if (mem) {
      mem.delete(id);
      for (const [fid, f] of memFiles) if (f.noteId === id) memFiles.delete(fid);
      return;
    }
    return writeTx([STORE, FILES], (notes, files) => {
      notes.delete(id);
      // 열쇠만 훑는다 — blob을 되살리지 않으므로 큰 붙임이 있어도 가볍다
      const req = files.index('noteId').openKeyCursor(IDBKeyRange.only(id));
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return;
        files.delete(cur.primaryKey);
        cur.continue();
      };
    });
  }

  async function bulkPut(notes) {
    if (mem) { notes.forEach(n => mem.set(n.id, n)); return; }
    return writeTx(STORE, s => notes.forEach(n => s.put(n)));
  }

  /* ---------- 붙임 파일 ---------- */
  /** 한 글에 딸린 붙임을 담은 차례대로 가져온다 */
  async function getFiles(noteId) {
    if (memFiles) {
      return [...memFiles.values()].filter(f => f.noteId === noteId)
        .sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
    }
    const store = db.transaction(FILES, 'readonly').objectStore(FILES);
    const out = await wrap(store.index('noteId').getAll(IDBKeyRange.only(noteId)));
    return (out || []).sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
  }

  async function getFile(id) {
    if (memFiles) return memFiles.get(id) || null;
    return wrap(db.transaction(FILES, 'readonly').objectStore(FILES).get(id));
  }

  async function putFile(rec) {
    if (memFiles) { memFiles.set(rec.id, rec); return; }
    return writeTx(FILES, s => s.put(rec));
  }

  async function bulkPutFiles(recs) {
    if (memFiles) { recs.forEach(r => memFiles.set(r.id, r)); return; }
    return writeTx(FILES, s => recs.forEach(r => s.put(r)));
  }

  async function delFile(id) {
    if (memFiles) { memFiles.delete(id); return; }
    return writeTx(FILES, s => s.delete(id));
  }

  /** 한 글에 딸린 붙임을 통째로 지운다 */
  async function delFilesOf(noteId) {
    if (memFiles) {
      for (const [fid, f] of memFiles) if (f.noteId === noteId) memFiles.delete(fid);
      return;
    }
    return writeTx(FILES, files => {
      const req = files.index('noteId').openKeyCursor(IDBKeyRange.only(noteId));
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return;
        files.delete(cur.primaryKey);
        cur.continue();
      };
    });
  }

  /** 붙임의 요약만 훑는다 — 통계와 청소에 쓴다 */
  async function allFileMeta() {
    const strip = (v) => ({
      id: v.id, noteId: v.noteId, name: v.name, type: v.type,
      size: v.size || 0, addedAt: v.addedAt || 0,
    });
    if (memFiles) return [...memFiles.values()].map(strip);
    const store = db.transaction(FILES, 'readonly').objectStore(FILES);
    const out = [];
    await cursorEach(store, null, cur => out.push(strip(cur.value)));
    return out;
  }

  /**
   * 주인 없는 붙임을 치운다(저장하지 않고 떠난 글이 남긴 것).
   * keepIds 밖이면서 '붙인 지 오래된' 것만 건드린다 —
   * 다른 탭에서 지금 쓰고 있는 글의 파일을 실수로 지우지 않기 위함이다.
   */
  async function gcOrphanFiles(keepIds, graceMs, limit) {
    if (!db || stale) return 0;
    const keep = new Set(keepIds);
    const cutoff = Date.now() - (graceMs || 24 * 60 * 60 * 1000);
    const cap = limit || 200;
    let removed = 0;
    await writeTx(FILES, files => {
      // addedAt 색인으로 '오래된 것'만 훑는다 — 방금 붙인 파일은 아예 보지 않는다
      const req = files.index('addedAt').openCursor(IDBKeyRange.upperBound(cutoff));
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur || removed >= cap) return;
        if (!keep.has(cur.value.noteId)) { files.delete(cur.primaryKey); removed++; }
        cur.continue();
      };
    });
    return removed;
  }

  return {
    open, persistent, isStale, onPromote, onStale,
    getAll, get, put, del, bulkPut,
    getFiles, getFile, putFile, bulkPutFiles, delFile, delFilesOf,
    allFileMeta, gcOrphanFiles,
  };
})();
