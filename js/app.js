/* 여백 — 본체 (길찾기 · 검색 · 색인 · 열람 · 서랍) */

/* ---------- 공용 UI ---------- */
const UI = (() => {
  'use strict';

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function toast(msg) {
    const rootEl = document.getElementById('toast-root');
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    rootEl.appendChild(el);
    setTimeout(() => {
      el.classList.add('hide');
      setTimeout(() => el.remove(), 350);
    }, 2400);
  }

  function openModal(innerHTML) {
    const back = document.createElement('div');
    back.className = 'modal-backdrop';
    back.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${innerHTML}</div>`;
    document.getElementById('modal-root').appendChild(back);

    let onClose = null;
    const close = () => {
      document.removeEventListener('keydown', onEsc);
      back.remove();
      if (onClose) onClose();
    };
    const onEsc = (e) => { if (e.key === 'Escape') close(); };
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
    document.addEventListener('keydown', onEsc);

    return {
      el: back.querySelector('.modal'),
      close,
      set onclose(fn) { onClose = fn; },
    };
  }

  function confirmModal({ title, body, okText = '지우기', cancelText = '그만두기' }) {
    return new Promise((resolve) => {
      const m = openModal(`
        <h3>${esc(title)}</h3>
        <p>${body}</p>
        <div class="modal-actions">
          <button type="button" class="btn m-cancel">${esc(cancelText)}</button>
          <button type="button" class="btn btn-primary m-ok">${esc(okText)}</button>
        </div>
      `);
      let done = false;
      m.onclose = () => { if (!done) { done = true; resolve(false); } };
      m.el.querySelector('.m-ok').addEventListener('click', () => { done = true; resolve(true); m.close(); });
      m.el.querySelector('.m-cancel').addEventListener('click', () => { done = true; resolve(false); m.close(); });
    });
  }

  function promptModal({ title, placeholder = '', value = '', okText = '확인' }) {
    return new Promise((resolve) => {
      const m = openModal(`
        <h3>${esc(title)}</h3>
        <input type="text" class="m-input" placeholder="${esc(placeholder)}" value="${esc(value)}">
        <div class="modal-actions">
          <button type="button" class="btn m-cancel">그만두기</button>
          <button type="button" class="btn btn-primary m-ok">${esc(okText)}</button>
        </div>
      `);
      const input = m.el.querySelector('.m-input');
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); m.close(); } };
      m.onclose = () => { if (!done) { done = true; resolve(null); } };
      m.el.querySelector('.m-ok').addEventListener('click', () => finish(input.value.trim() || null));
      m.el.querySelector('.m-cancel').addEventListener('click', () => finish(null));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(input.value.trim() || null); }
      });
      setTimeout(() => input.focus(), 50);
    });
  }

  return { uuid, esc, toast, openModal, confirmModal, promptModal };
})();

/* ---------- 본체 ---------- */
const App = (() => {
  'use strict';

  const esc = UI.esc;
  let notes = [];
  let persistent = true;
  let lastRoute = null;
  let currentSearch = '';
  let focusSearchAfterRender = false;

  const appEl = () => document.getElementById('app');

  /* ----- 날짜/글자 ----- */
  function fmtDate(ts) {
    try {
      return new Date(ts).toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });
    } catch (e) { return ''; }
  }

  function sameDay(a, b) {
    const x = new Date(a), y = new Date(b);
    return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
  }

  /** 글자 수를 보존하며 소문자로(검색 위치 계산용) */
  function lowerPreserve(str) {
    let out = '';
    for (const ch of str) {
      const low = ch.toLowerCase();
      out += (low.length === ch.length) ? low : ch;
    }
    return out;
  }

  /* ----- 검색 ----- */
  function search(rawQuery) {
    const raw = rawQuery.trim();
    if (!raw) return [];
    const nq = lowerPreserve(raw);
    const isCho = HANGUL.isChoseongQuery(raw);
    const tokens = nq.split(/\s+/).filter(Boolean);
    const results = [];

    for (const n of notes) {
      const ltitle = lowerPreserve(n.title);
      const ltext = lowerPreserve(n.text || '');
      const ltags = (n.tags || []).map(lowerPreserve);
      let hit = null;

      const tIdx = ltitle.indexOf(nq);
      if (tIdx >= 0) {
        hit = { score: tIdx === 0 ? 100 : 80, titleIdx: tIdx, titleLen: nq.length };
      } else if (isCho) {
        const found = HANGUL.choseongFind(n.title, raw);
        if (found) {
          hit = { score: found.index === 0 ? 72 : 68, titleIdx: found.index, titleLen: found.length };
        } else if ((n.tags || []).some(t => HANGUL.choseongFind(t, raw))) {
          hit = { score: 58 };
        }
      }
      if (!hit && ltags.some(t => t.includes(nq))) {
        hit = { score: 60 };
      }
      if (!hit) {
        const xIdx = ltext.indexOf(nq);
        if (xIdx >= 0) hit = { score: 40, textIdx: xIdx, textLen: nq.length };
      }
      if (!hit && tokens.length > 1) {
        // 띄어 쓴 낱말들이 제목·본문·태그 어딘가에 모두 있으면 잡는다
        const hay = ltitle + ' ' + ltags.join(' ') + ' ' + ltext;
        if (tokens.every(t => hay.includes(t))) {
          const first = ltext.indexOf(tokens[0]);
          hit = { score: 30 };
          if (first >= 0) { hit.textIdx = first; hit.textLen = tokens[0].length; }
        }
      }

      if (hit) {
        hit.note = n;
        hit.score += Math.min(9, (n.updatedAt || 0) / 1e15); // 같은 점수면 최근 것 먼저
        results.push(hit);
      }
    }

    results.sort((a, b) => b.score - a.score || (b.note.updatedAt || 0) - (a.note.updatedAt || 0));
    return results.slice(0, 60);
  }

  function markSlice(str, idx, len) {
    if (idx == null || idx < 0 || !len) return esc(str);
    return esc(str.slice(0, idx)) + '<mark>' + esc(str.slice(idx, idx + len)) + '</mark>' + esc(str.slice(idx + len));
  }

  function makeSnippet(text, idx, len) {
    if (!text) return '';
    if (idx == null || idx < 0) {
      const s = text.slice(0, 110);
      return esc(s) + (text.length > 110 ? '…' : '');
    }
    const start = Math.max(0, idx - 38);
    const end = Math.min(text.length, idx + len + 84);
    return (start > 0 ? '…' : '') +
      esc(text.slice(start, idx)) + '<mark>' + esc(text.slice(idx, idx + len)) + '</mark>' +
      esc(text.slice(idx + len, end)) + (end < text.length ? '…' : '');
  }

  /* ----- 조각 그리기 ----- */
  function chipsHtml(tags) {
    return (tags || []).map(t =>
      `<a class="chip" href="#/tag/${encodeURIComponent(t)}">${esc(t)}</a>`
    ).join(' ');
  }

  function rowHtml(n, { titleIdx, titleLen, snippetHtml } = {}) {
    return `
      <li class="entry-row">
        <a href="#/note/${n.id}">
          <div class="entry-row-title">${markSlice(n.title, titleIdx, titleLen)}</div>
          <div class="entry-row-meta">
            <span>${fmtDate(n.updatedAt)}</span>
            ${(n.tags || []).length ? `<span>${(n.tags || []).map(t => `<span class="chip">${esc(t)}</span>`).join(' ')}</span>` : ''}
          </div>
          ${snippetHtml ? `<div class="entry-row-snippet">${snippetHtml}</div>` : ''}
        </a>
      </li>`;
  }

  /* ----- 홈(찾기) ----- */
  function renderHome() {
    appEl().innerHTML = `
      <section class="view home">
        <div class="hero">
          <h1 class="wordmark">여백<span class="hanja" aria-hidden="true">餘白</span></h1>
          <p class="tagline">배운 것들이 잊히지 않도록 — 나만의 낱말과 문장을 모아 두는 사전.</p>
          <div class="search-box">
            <input class="search-input" type="search" autocomplete="off" spellcheck="false"
                   placeholder="찾고 싶은 낱말이나 문장"
                   aria-label="기록 검색" value="${esc(currentSearch)}">
            <p class="search-hint">초성만 적어도 찾아 드립니다 · <kbd>ㅇㅂ</kbd> → 여백</p>
          </div>
        </div>
        <div id="home-body"></div>
      </section>
    `;

    const input = appEl().querySelector('.search-input');
    let timer = null;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        currentSearch = input.value;
        renderHomeBody();
      }, 120);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { input.value = ''; currentSearch = ''; renderHomeBody(); }
      if (e.key === 'Enter') {
        const first = appEl().querySelector('#home-body .entry-row a');
        if (first && currentSearch.trim()) first.click();
      }
    });

    renderHomeBody();
    if (focusSearchAfterRender) {
      focusSearchAfterRender = false;
      input.focus();
    }
  }

  function renderHomeBody() {
    const body = document.getElementById('home-body');
    if (!body) return;
    const q = currentSearch.trim();

    if (q) {
      const results = search(q);
      if (!results.length) {
        body.innerHTML = `
          <div class="empty">
            <span class="big">여백</span>
            ‘${esc(q)}’에 닿는 기록이 아직 없습니다.<br>
            <a href="#/write" style="color:var(--seal)">지금 이 자리에 첫 기록을 남겨 보세요 →</a>
          </div>`;
        return;
      }
      body.innerHTML = `
        <h2 class="section-title">찾은 기록 <span class="count">${results.length}건</span></h2>
        <ul class="entry-list">
          ${results.map(r => rowHtml(r.note, {
            titleIdx: r.titleIdx, titleLen: r.titleLen,
            snippetHtml: makeSnippet(r.note.text || '', r.textIdx, r.textLen || 0),
          })).join('')}
        </ul>`;
      return;
    }

    if (!notes.length) {
      body.innerHTML = `
        <div class="empty">
          <span class="big">餘白</span>
          아직 아무것도 적히지 않은 여백입니다.<br>
          <a href="#/write" style="color:var(--seal)">첫 기록을 남겨 보세요 →</a>
        </div>`;
      return;
    }

    const recent = [...notes].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 8);
    const tagCount = new Map();
    for (const n of notes) for (const t of n.tags || []) tagCount.set(t, (tagCount.get(t) || 0) + 1);
    const topTags = [...tagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);
    const totalChars = notes.reduce((s, n) => s + (n.text ? n.text.length : 0), 0);

    body.innerHTML = `
      <h2 class="section-title">요즘의 기록</h2>
      <ul class="entry-list">
        ${recent.map(n => rowHtml(n, { snippetHtml: esc((n.text || '').slice(0, 110)) + ((n.text || '').length > 110 ? '…' : '') })).join('')}
      </ul>
      ${topTags.length ? `
        <h2 class="section-title">자주 단 태그</h2>
        <div class="chip-cloud">
          ${topTags.map(([t, c]) => `<a class="chip" href="#/tag/${encodeURIComponent(t)}">${esc(t)} ${c}</a>`).join('')}
        </div>` : ''}
      <p class="stats-line">여백에 담긴 기록 ${notes.length}편 · ${totalChars.toLocaleString('ko-KR')}자</p>
    `;
  }

  /* ----- 색인 ----- */
  function renderIndex() {
    const groups = new Map();
    for (const n of notes) {
      const letter = HANGUL.indexLetter(n.title);
      if (!groups.has(letter)) groups.set(letter, []);
      groups.get(letter).push(n);
    }
    for (const list of groups.values()) {
      list.sort((a, b) => a.title.localeCompare(b.title, 'ko'));
    }

    const tabs = HANGUL.INDEX_ORDER.map(letter => {
      const has = groups.has(letter);
      return `<button type="button" data-letter="${esc(letter)}" ${has ? '' : 'disabled'}>${esc(letter)}</button>`;
    }).join('');

    const sections = HANGUL.INDEX_ORDER.filter(l => groups.has(l)).map(letter => `
      <h3 class="index-letter" id="idx-${esc(letter)}">${esc(letter)} <small>${groups.get(letter).length}편</small></h3>
      <ul class="entry-list">
        ${groups.get(letter).map(n => rowHtml(n)).join('')}
      </ul>
    `).join('');

    appEl().innerHTML = `
      <section class="view">
        <header class="index-head">
          <h1 class="page-title">색인</h1>
          <p class="page-desc">모든 기록이 종이 사전처럼 가나다순으로 놓여 있습니다 · ${notes.length}편</p>
        </header>
        <nav class="index-tabs" aria-label="첫 글자로 가기">${tabs}</nav>
        ${sections || `
          <div class="empty">
            <span class="big">색인</span>
            실릴 기록이 아직 없습니다.<br>
            <a href="#/write" style="color:var(--seal)">첫 표제어를 올려 보세요 →</a>
          </div>`}
      </section>
    `;

    appEl().querySelectorAll('.index-tabs button:not(:disabled)').forEach(btn => {
      btn.addEventListener('click', () => {
        const target = document.getElementById('idx-' + btn.dataset.letter);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  }

  /* ----- 열람 ----- */
  function renderNote(id) {
    const n = notes.find(x => x.id === id);
    if (!n) return renderMissing();

    const sorted = [...notes].sort((a, b) => a.title.localeCompare(b.title, 'ko'));
    const i = sorted.findIndex(x => x.id === id);
    const prev = i > 0 ? sorted[i - 1] : null;
    const next = i < sorted.length - 1 ? sorted[i + 1] : null;

    appEl().innerHTML = `
      <article class="view entry">
        <h1 class="entry-title">${esc(n.title)}</h1>
        <div class="entry-meta">
          ${(n.tags || []).length ? `<span>${chipsHtml(n.tags)}</span>` : ''}
          <span>${fmtDate(n.createdAt)}</span>
          ${!sameDay(n.createdAt, n.updatedAt) ? `<span>고쳐 씀 · ${fmtDate(n.updatedAt)}</span>` : ''}
          <span>${(n.text || '').length.toLocaleString('ko-KR')}자</span>
        </div>
        <div class="entry-body prose">${n.html}</div>
        <footer class="entry-foot">
          <nav class="entry-nav" aria-label="이웃 표제어">
            ${prev ? `<a href="#/note/${prev.id}" title="${esc(prev.title)}"><span class="dir">◂ </span>${esc(prev.title)}</a>` : '<span></span>'}
            ${next ? `<a href="#/note/${next.id}" title="${esc(next.title)}">${esc(next.title)}<span class="dir"> ▸</span></a>` : '<span></span>'}
          </nav>
          <div class="entry-actions">
            <a class="btn" href="#/edit/${n.id}">고쳐 쓰기</a>
            <button type="button" class="btn btn-danger" id="del-btn">지우기</button>
          </div>
        </footer>
      </article>
    `;

    // 바깥 링크는 새 창에서
    appEl().querySelectorAll('.entry-body a').forEach(a => {
      const href = a.getAttribute('href') || '';
      if (/^https?:/i.test(href)) {
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
      }
    });

    document.getElementById('del-btn').addEventListener('click', async () => {
      const ok = await UI.confirmModal({
        title: '기록 지우기',
        body: `「${esc(n.title)}」 — 한 번 지운 기록은 되돌릴 수 없습니다.`,
        okText: '지우기',
      });
      if (!ok) return;
      try {
        await DB.del(n.id);
      } catch (e) {
        UI.toast('지우지 못했습니다.');
        return;
      }
      notes = notes.filter(x => x.id !== n.id);
      updateFoot();
      UI.toast('여백으로 돌려보냈습니다.');
      location.hash = '#/';
    });
  }

  function renderMissing() {
    appEl().innerHTML = `
      <section class="view">
        <div class="empty" style="padding-top:6rem">
          <span class="big">빈 자리</span>
          찾으시는 기록이 여기 없습니다.<br>
          <a href="#/" style="color:var(--seal)">처음으로 돌아가기 →</a>
        </div>
      </section>`;
  }

  /* ----- 태그 ----- */
  function renderTag(tag) {
    const list = notes.filter(n => (n.tags || []).includes(tag))
      .sort((a, b) => a.title.localeCompare(b.title, 'ko'));
    appEl().innerHTML = `
      <section class="view">
        <header class="index-head">
          <h1 class="page-title" style="letter-spacing:.1em;text-indent:.1em">「${esc(tag)}」</h1>
          <p class="page-desc">이 태그가 달린 기록 ${list.length}편</p>
        </header>
        ${list.length ? `
          <ul class="entry-list" style="margin-top:1.6rem">
            ${list.map(n => rowHtml(n, { snippetHtml: esc((n.text || '').slice(0, 110)) + ((n.text || '').length > 110 ? '…' : '') })).join('')}
          </ul>` : `
          <div class="empty">이 태그가 달린 기록이 없습니다.</div>`}
      </section>`;
  }

  /* ----- 쓰기 ----- */
  function renderEditor(id) {
    let existing = null;
    if (id) {
      existing = notes.find(x => x.id === id);
      if (!existing) return renderMissing();
    }
    Editor.mount(appEl(), existing, {
      onSave(saved) {
        const i = notes.findIndex(x => x.id === saved.id);
        if (i >= 0) notes[i] = saved; else notes.push(saved);
        updateFoot();
        UI.toast('여백에 담아 두었습니다.');
        location.hash = '#/note/' + saved.id;
      },
    });
  }

  /* ----- 길찾기 ----- */
  function parseRoute() {
    const h = (location.hash || '#/').replace(/^#\/?/, '');
    const parts = h.split('/');
    const name = parts[0] || 'home';
    if (name === '') return { name: 'home' };
    if (name === 'index') return { name: 'index' };
    if (name === 'write') return { name: 'write' };
    if (name === 'edit' && parts[1]) return { name: 'edit', id: parts[1] };
    if (name === 'note' && parts[1]) return { name: 'note', id: parts[1] };
    if (name === 'tag' && parts[1] !== undefined) {
      let tag = parts.slice(1).join('/');
      try { tag = decodeURIComponent(tag); } catch (e) { /* 그대로 둔다 */ }
      return { name: 'tag', tag };
    }
    return { name: 'home' };
  }

  function updateNav(routeName) {
    const map = { home: 'home', index: 'index', write: 'write', edit: 'write' };
    const active = map[routeName] || '';
    document.querySelectorAll('.site-nav a[data-nav]').forEach(a => {
      a.classList.toggle('active', a.dataset.nav === active);
    });
  }

  function onRoute() {
    if (lastRoute && (lastRoute.name === 'write' || lastRoute.name === 'edit')) {
      Editor.unmount();
    }
    const route = parseRoute();
    lastRoute = route;
    updateNav(route.name);
    window.scrollTo(0, 0);

    switch (route.name) {
      case 'home': renderHome(); break;
      case 'index': renderIndex(); break;
      case 'write': renderEditor(null); break;
      case 'edit': renderEditor(route.id); break;
      case 'note': renderNote(route.id); break;
      case 'tag': renderTag(route.tag); break;
      default: renderHome();
    }
  }

  /* ----- 서랍(내보내기·가져오기) ----- */
  function openDrawer() {
    const totalChars = notes.reduce((s, n) => s + (n.text ? n.text.length : 0), 0);
    const tagSet = new Set(notes.flatMap(n => n.tags || []));
    const m = UI.openModal(`
      <h3>서랍</h3>
      <div class="drawer-stats">
        <div><b>${notes.length.toLocaleString('ko-KR')}</b><span>기록</span></div>
        <div><b>${totalChars.toLocaleString('ko-KR')}</b><span>글자</span></div>
        <div><b>${tagSet.size.toLocaleString('ko-KR')}</b><span>태그</span></div>
      </div>
      <div class="drawer-row">
        <div>모든 기록을 파일로 갈무리
          <p>다른 기기로 옮기거나 만일을 대비해 남겨 둡니다.</p>
        </div>
        <button type="button" class="btn d-export">내보내기</button>
      </div>
      <div class="drawer-row">
        <div>갈무리해 둔 파일 열기
          <p>같은 기록이 겹치면 더 새로운 쪽만 남습니다.</p>
        </div>
        <button type="button" class="btn d-import">가져오기</button>
        <input type="file" class="d-file" accept=".json,application/json" hidden>
      </div>
      <p class="notice">기록은 이 브라우저 안(IndexedDB)에만 머뭅니다. 브라우저의 사이트 데이터를 지우면 함께 사라지니, 이따금 내보내기로 갈무리해 두세요.</p>
    `);

    m.el.querySelector('.d-export').addEventListener('click', () => {
      const payload = {
        app: 'yeobaeck',
        version: 1,
        exportedAt: new Date().toISOString(),
        notes,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const d = new Date();
      const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      a.href = url;
      a.download = `여백-갈무리-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      UI.toast('기록을 파일로 내보냈습니다.');
    });

    const fileInput = m.el.querySelector('.d-file');
    m.el.querySelector('.d-import').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        const incoming = Array.isArray(data) ? data : data.notes;
        if (!Array.isArray(incoming)) throw new Error('bad file');
        const { added, updated } = await importNotes(incoming);
        m.close();
        onRoute();
        updateFoot();
        UI.toast(`기록 ${added}편을 새로 담고, ${updated}편을 새로 고쳤습니다.`);
      } catch (e) {
        UI.toast('여백의 갈무리 파일이 아닌 것 같습니다.');
      }
      fileInput.value = '';
    });
  }

  async function importNotes(incoming) {
    const byId = new Map(notes.map(n => [n.id, n]));
    const toPut = [];
    let added = 0, updated = 0;

    for (const raw of incoming) {
      if (!raw || typeof raw !== 'object') continue;
      const title = typeof raw.title === 'string' ? raw.title.trim() : '';
      if (!title) continue;
      const html = Editor.sanitize(typeof raw.html === 'string' ? raw.html : '');
      const note = {
        id: typeof raw.id === 'string' && raw.id ? raw.id : UI.uuid(),
        title: title.slice(0, 200),
        html,
        text: Editor.htmlToText(html),
        tags: Array.isArray(raw.tags) ? raw.tags.filter(t => typeof t === 'string' && t.trim()).map(t => t.trim()).slice(0, 12) : [],
        createdAt: Number(raw.createdAt) || Date.now(),
        updatedAt: Number(raw.updatedAt) || Number(raw.createdAt) || Date.now(),
      };
      const existing = byId.get(note.id);
      if (existing) {
        if (note.updatedAt > existing.updatedAt) { toPut.push(note); byId.set(note.id, note); updated++; }
      } else {
        toPut.push(note);
        byId.set(note.id, note);
        added++;
      }
    }

    if (toPut.length) await DB.bulkPut(toPut);
    notes = [...byId.values()];
    return { added, updated };
  }

  /* ----- 처음 심어 두는 안내 글 ----- */
  async function seedIfEmpty() {
    let seeded = null;
    try { seeded = localStorage.getItem('yeobaeck.seeded.v1'); } catch (e) { /* 무시 */ }
    if (notes.length || seeded) return;

    const now = Date.now();
    const make = (title, tags, html, offset) => ({
      id: UI.uuid(),
      title,
      html,
      text: Editor.htmlToText(html),
      tags,
      createdAt: now - offset,
      updatedAt: now - offset,
    });

    const seeds = [
      make('여백 사용법', ['안내'], `
        <p>어서 오세요. <b>여백</b>은 배운 것을 적어 두고, 사전처럼 다시 꺼내 보는 당신만의 기록 공간입니다.</p>
        <h2>쓰기</h2>
        <p>차림표의 「쓰기」에서 새 기록을 시작합니다. 도구막대로 <b>굵게</b>, <i>기울임</i>, <mark>형광펜</mark>, 인용, 목록, 코드 같은 서식을 쓸 수 있습니다.</p>
        <blockquote>사진은 글 쓰는 자리에 붙여넣거나(Ctrl+V) 끌어다 놓으면, 알맞은 크기로 줄여서 함께 담깁니다.</blockquote>
        <h2>찾기</h2>
        <p>첫 화면의 검색창은 제목·본문·태그를 한꺼번에 뒤집니다. <b>초성</b>만 적어도 표제어를 찾아 줍니다 — 이를테면 <code>ㅇㅂ</code>이라고 치면 ‘여백’이 나옵니다.</p>
        <h2>색인</h2>
        <p>「색인」에서는 모든 기록이 종이 사전처럼 ㄱㄴㄷ 순으로 늘어섭니다. 첫 글자를 누르면 그 자리로 데려다 드립니다.</p>
        <h2>서랍</h2>
        <p>기록은 이 브라우저 안에 저장됩니다. 기기를 바꾸거나 브라우저 데이터를 지우면 사라질 수 있으니, 오른쪽 위 「서랍」에서 <b>내보내기</b>로 이따금 갈무리해 두세요. 그 파일을 <b>가져오기</b> 하면 어느 기기에서든 이어집니다.</p>
        <hr>
        <p>이 안내와 예시 글 두 편은 여느 기록처럼 지울 수 있습니다. 이제, 당신의 여백을 채워 보세요.</p>
      `, 3000),
      make('에빙하우스 망각 곡선', ['공부법', '심리학'], `
        <p>헤르만 에빙하우스는 기억이 시간에 따라 어떻게 사라지는지를, 스스로를 실험대에 올려 재어 보았다.</p>
        <blockquote>배운 것의 절반 남짓은 하루 안에 사라진다. 그러나 잊히기 전에 다시 보면, 곡선은 눈에 띄게 완만해진다.</blockquote>
        <h2>복습 간격</h2>
        <table><thead><tr><th>회차</th><th>시점</th></tr></thead><tbody>
          <tr><td>1</td><td>배운 직후</td></tr>
          <tr><td>2</td><td>하루 뒤</td></tr>
          <tr><td>3</td><td>일주일 뒤</td></tr>
          <tr><td>4</td><td>한 달 뒤</td></tr>
        </tbody></table>
        <p>요컨대 <mark>잊힐 만할 때 다시 꺼내 보는 것</mark>. 이 사전에 적어 두고 검색으로 다시 꺼내 보는 일 자체가 복습이 된다.</p>
      `, 2000),
      make('Active Recall', ['공부법'], `
        <p>능동 회상(Active Recall)은 자료를 다시 읽는 대신 <b>스스로에게 묻고, 기억에서 답을 끄집어내는</b> 공부법이다.</p>
        <ul>
          <li>책을 덮고, 방금 배운 것을 백지에 적어 본다.</li>
          <li>답을 보기 전에 먼저 틀려 보는 것이 오래 남는다.</li>
        </ul>
        <p>이 여백에 글을 쓸 때도 요약을 베끼지 말고, 기억만으로 먼저 써 본 뒤 빈틈을 메워 보자.</p>
      `, 1000),
    ];

    try {
      await DB.bulkPut(seeds);
      notes = seeds;
      try { localStorage.setItem('yeobaeck.seeded.v1', '1'); } catch (e) { /* 무시 */ }
    } catch (e) { /* 심기 실패는 조용히 넘어간다 */ }
  }

  /* ----- 몸통 ----- */
  function updateFoot() {
    const el = document.getElementById('foot-count');
    if (el) el.textContent = notes.length ? `지금까지 ${notes.length}편의 기록` : '';
  }

  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem('yeobaeck.theme', t); } catch (e) { /* 무시 */ }
    const btn = document.getElementById('theme-toggle');
    if (btn) btn.setAttribute('aria-label', t === 'dark' ? '밝은 낮으로' : '어두운 밤으로');
  }

  function bindHeader() {
    document.getElementById('theme-toggle').addEventListener('click', () => {
      const cur = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
      applyTheme(cur === 'dark' ? 'light' : 'dark');
    });
    document.getElementById('drawer-open').addEventListener('click', openDrawer);

    document.addEventListener('keydown', (e) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      const a = document.activeElement;
      if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return;
      if (document.querySelector('.modal-backdrop')) return;
      e.preventDefault();
      if (parseRoute().name === 'home') {
        const s = document.querySelector('.search-input');
        if (s) s.focus();
      } else {
        focusSearchAfterRender = true;
        location.hash = '#/';
      }
    });
  }

  async function boot() {
    persistent = await DB.open();
    if (!persistent) {
      const warn = document.createElement('div');
      warn.className = 'storage-warn';
      warn.textContent = '이 브라우저에서는 오래 저장할 공간을 열지 못해, 창을 닫으면 기록이 사라집니다. 서랍의 내보내기로 갈무리해 주세요.';
      document.body.insertBefore(warn, document.getElementById('app'));
    }

    try {
      notes = await DB.getAll() || [];
    } catch (e) {
      notes = [];
    }
    await seedIfEmpty();

    bindHeader();
    window.addEventListener('hashchange', onRoute);
    onRoute();
    updateFoot();
  }

  return { boot };
})();

App.boot();
