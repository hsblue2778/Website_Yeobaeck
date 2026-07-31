/* 여백 — 글쓰기 (서식 · 사진 · 임시저장 · HTML 정돈) */
const Editor = (() => {
  'use strict';

  /* ---------- HTML 정돈(sanitize) ---------- */
  // 허용 태그와 태그별 허용 속성. 그 밖의 태그는 내용만 남기고 벗겨 낸다.
  const ALLOWED = {
    P: ['class'], H2: ['class'], H3: ['class'], BR: [], HR: [],
    B: [], STRONG: [], I: [], EM: [], U: [], S: [], STRIKE: [], DEL: [],
    MARK: [], SUP: [], SUB: [],
    BLOCKQUOTE: ['class'], UL: [], OL: [], LI: ['class'],
    PRE: ['class'], CODE: [],
    A: ['href'], IMG: ['src', 'alt'],
    FIGURE: [], FIGCAPTION: [],
    TABLE: [], THEAD: [], TBODY: [], TFOOT: [], TR: [], TH: [], TD: [],
    DIV: [], SPAN: ['class'],
  };
  // class는 서식 용도로만 허용한다: span은 글자 크기, 문단은 줄 간격
  const SIZE_CLASSES = ['t-sm', 't-lg', 't-xl'];
  const LH_CLASSES = ['lh-tight', 'lh-loose'];
  // 내용까지 통째로 버리는 태그
  const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'TITLE', 'HEAD', 'FORM', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'VIDEO', 'AUDIO', 'SVG', 'CANVAS', 'NOSCRIPT', 'TEMPLATE']);

  function safeHref(v) {
    const s = (v || '').trim();
    return /^(https?:|mailto:|#)/i.test(s) ? s : null;
  }

  function safeSrc(v) {
    const s = (v || '').trim();
    return /^(data:image\/|https?:)/i.test(s) ? s : null;
  }

  function sanitize(html) {
    const doc = new DOMParser().parseFromString('<div>' + (html || '') + '</div>', 'text/html');
    const rootEl = doc.body.firstChild;

    (function walk(node) {
      const children = [...node.childNodes];
      for (const child of children) {
        if (child.nodeType === Node.TEXT_NODE) continue;
        if (child.nodeType !== Node.ELEMENT_NODE) { child.remove(); continue; }

        const tag = child.tagName;
        if (DROP.has(tag)) { child.remove(); continue; }

        walk(child);

        if (!(tag in ALLOWED)) {
          // 허용하지 않는 태그는 내용만 남긴다
          while (child.firstChild) node.insertBefore(child.firstChild, child);
          child.remove();
          continue;
        }

        // 속성 정돈
        const keep = ALLOWED[tag];
        for (const attr of [...child.attributes]) {
          const name = attr.name.toLowerCase();
          if (!keep.includes(name)) { child.removeAttribute(attr.name); continue; }
          if (name === 'href') {
            const v = safeHref(attr.value);
            if (v) child.setAttribute('href', v); else child.removeAttribute(attr.name);
          } else if (name === 'src') {
            const v = safeSrc(attr.value);
            if (v) child.setAttribute('src', v); else { child.remove(); break; }
          } else if (name === 'class') {
            const allowedClasses = tag === 'SPAN' ? SIZE_CLASSES : LH_CLASSES;
            const kept = attr.value.split(/\s+/).filter(c => allowedClasses.includes(c));
            if (kept.length) child.setAttribute('class', kept.join(' '));
            else child.removeAttribute(attr.name);
          }
        }

        // src 없는 이미지는 버리고, 크기 구실이 없는 span은 벗긴다
        if (tag === 'IMG' && !child.getAttribute('src')) child.remove();
        if (tag === 'SPAN' && !child.getAttribute('class')) {
          while (child.firstChild) node.insertBefore(child.firstChild, child);
          child.remove();
        }
      }
    })(rootEl);

    return rootEl.innerHTML;
  }

  function htmlToText(html) {
    const doc = new DOMParser().parseFromString('<div>' + (html || '') + '</div>', 'text/html');
    doc.querySelectorAll('script,style').forEach(el => el.remove());
    // 블록 요소와 표 칸 사이에 공백을 넣어 단어가 붙지 않게 한다
    doc.querySelectorAll('p,div,h2,h3,li,blockquote,pre,br,tr,td,th,figcaption').forEach(el => {
      el.insertAdjacentText('afterend', ' ');
    });
    return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
  }

  /* ---------- 사진 처리 ---------- */
  const MAX_EDGE = 1600;      // 긴 변 기준 픽셀
  const JPEG_QUALITY = 0.85;
  const KEEP_ORIGINAL_UNDER = 400 * 1024; // 이보다 작은 png는 원본 유지
  const GIF_MAX = 4 * 1024 * 1024;        // 움직이는 그림 허용 상한

  function readAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  function imageError(code) {
    const e = new Error(code);
    e.code = code;
    return e;
  }

  async function compressImage(file) {
    // 움직이는 그림(gif)은 변환하면 멈추므로 원본을 쓰되, 지나치게 크면 거절한다
    if (file.type === 'image/gif') {
      if (file.size > GIF_MAX) throw imageError('too-big');
      return readAsDataURL(file);
    }

    const original = await readAsDataURL(file);
    if (file.type === 'image/png' && file.size <= KEEP_ORIGINAL_UNDER) return original;

    let img;
    try {
      img = await loadImage(original);
    } catch (e) {
      // 브라우저가 그리지 못하는 형식(HEIC/TIFF 등)은 넣어 봐야 깨진 그림이 된다
      throw imageError('unsupported');
    }

    try {
      const { naturalWidth: w, naturalHeight: h } = img;
      if (!w || !h) return original;

      const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
      const cw = Math.max(1, Math.round(w * scale));
      const ch = Math.max(1, Math.round(h * scale));

      if (scale === 1 && file.size <= KEEP_ORIGINAL_UNDER) return original;

      const canvas = document.createElement('canvas');
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext('2d');
      // 투명 배경이 검게 변하지 않도록 지금 테마의 종이색을 깔아 준다
      const paper = getComputedStyle(document.documentElement).getPropertyValue('--paper').trim() || '#f7f4ee';
      ctx.fillStyle = paper;
      ctx.fillRect(0, 0, cw, ch);
      ctx.drawImage(img, 0, 0, cw, ch);
      const out = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
      // 압축이 오히려 커졌다면 원본을 쓴다
      return out.length < original.length ? out : original;
    } catch (e) {
      return original;
    }
  }

  /* ---------- 편집기 상태 ---------- */
  let root = null;
  let editorEl = null, titleEl = null, tagInputEl = null, chipsEl = null;
  let countEl = null, draftStatusEl = null, fileInputEl = null, saveBtnEl = null;
  let note = null;        // 수정 대상(새 글이면 null)
  let tags = [];
  let onSaveCb = null;
  let draftKey = 'yeobaeck.draft.new';
  let draftTimer = null;
  let draftPending = false;      // 예약된 임시저장이 아직 실행되지 않았는가
  let pendingOldDraft = null;    // 배너로 안내했지만 아직 결정되지 않은 이전 임시저장
  let keydownHandler = null;
  let beforeUnloadHandler = null;
  let savedRange = null;  // 모달이 초점을 가져갈 때 선택 영역 보관
  let mountGen = 0;       // 세대 토큰 — 화면이 바뀐 뒤 도착한 비동기 작업을 무시하기 위함
  let saving = false;
  let pendingImages = 0;  // 압축 중인 사진 수
  let lineHeight = 'normal'; // 이 글의 줄 간격 (tight | normal | loose)
  const LINE_HEIGHTS = ['tight', 'normal', 'loose'];

  const $ = (sel) => root.querySelector(sel);

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ---------- 도구막대 정의 ---------- */
  const SVG_UL = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="3.4" cy="5" r="0.9" fill="currentColor" stroke="none"/><circle cx="3.4" cy="10" r="0.9" fill="currentColor" stroke="none"/><circle cx="3.4" cy="15" r="0.9" fill="currentColor" stroke="none"/><path d="M7.5 5h9M7.5 10h9M7.5 15h9"/></svg>';
  const SVG_OL = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8.5 5h8M8.5 10h8M8.5 15h8"/><text x="2" y="6.6" font-size="6.5" fill="currentColor" stroke="none" font-family="serif">1</text><text x="2" y="11.9" font-size="6.5" fill="currentColor" stroke="none" font-family="serif">2</text><text x="2" y="17.2" font-size="6.5" fill="currentColor" stroke="none" font-family="serif">3</text></svg>';
  const SVG_IMG = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="3.5" width="15" height="13" rx="2"/><circle cx="7" cy="8" r="1.4"/><path d="M4 14.5l4.2-4 3.3 3 2.5-2.3 3.5 3.3"/></svg>';
  const SVG_LINK = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8.5 11.5a3.5 3.5 0 0 0 5 0l2.5-2.5a3.54 3.54 0 0 0-5-5L9.6 5.4"/><path d="M11.5 8.5a3.5 3.5 0 0 0-5 0L4 11a3.54 3.54 0 0 0 5 5l1.4-1.4"/></svg>';

  const TOOLS = [
    { cmd: 'h2', label: '<span class="t-head">제<small>²</small></span>', title: '제목' },
    { cmd: 'h3', label: '<span class="t-head">제<small>³</small></span>', title: '작은 제목' },
    { sep: true },
    { cmd: 'bold', label: '<span class="t-bold">가</span>', title: '굵게 (Ctrl+B)' },
    { cmd: 'italic', label: '<span class="t-italic">가</span>', title: '기울임 (Ctrl+I)' },
    { cmd: 'underline', label: '<span class="t-under">가</span>', title: '밑줄 (Ctrl+U)' },
    { cmd: 'strike', label: '<span class="t-strike">가</span>', title: '취소선' },
    { cmd: 'mark', label: '<span class="t-mark">가</span>', title: '형광펜' },
    { sep: true },
    { menu: 'size', label: '글자 크기', title: '글자 크기 — 고른 부분에 적용' },
    { menu: 'lh', label: '줄간격', title: '줄 간격 — 고른 문단 또는 글 전체' },
    { sep: true },
    { cmd: 'quote', label: '❝', title: '인용' },
    { cmd: 'ul', label: SVG_UL, title: '목록' },
    { cmd: 'ol', label: SVG_OL, title: '번호 목록' },
    { cmd: 'code', label: '<span style="font-size:.78rem;letter-spacing:-.05em">&lt;/&gt;</span>', title: '코드' },
    { cmd: 'hr', label: '⁂', title: '구분선' },
    { sep: true },
    { cmd: 'link', label: SVG_LINK, title: '링크' },
    { cmd: 'image', label: SVG_IMG, title: '사진 넣기' },
  ];

  /* ---------- 그리기 ---------- */
  function mount(container, existingNote, opts) {
    mountGen++;
    root = container;
    note = existingNote || null;
    tags = note ? [...(note.tags || [])] : [];
    onSaveCb = opts && opts.onSave;
    draftKey = 'yeobaeck.draft.' + (note ? note.id : 'new');
    saving = false;
    pendingImages = 0;
    draftPending = false;
    pendingOldDraft = null;
    savedRange = null;

    const toolsHtml = TOOLS.map(t => {
      if (t.sep) return '<span class="sep"></span>';
      if (t.menu) {
        return `<button type="button" class="tool tool-menu-btn" data-menu="${t.menu}" title="${esc(t.title)}" aria-label="${esc(t.title)}" aria-haspopup="menu" aria-expanded="false">${esc(t.label)}<span class="menu-caret" aria-hidden="true">▾</span></button>`;
      }
      return `<button type="button" class="tool" data-cmd="${t.cmd}" title="${esc(t.title)}" aria-label="${esc(t.title)}">${t.label}</button>`;
    }).join('');

    container.innerHTML = `
      <section class="view editor-view">
        <input class="title-input" type="text" maxlength="200"
               placeholder="표제어 — 무엇을 배웠나요?"
               value="${note ? esc(note.title) : ''}">
        <div class="tags-row">
          <div class="chips" style="display:contents"></div>
          <input class="tag-input" type="text" maxlength="40"
                 placeholder="태그를 적고 Enter (예: 물리, 단어)">
        </div>
        <div class="draft-slot"></div>
        <div class="toolbar" role="toolbar" aria-label="서식">${toolsHtml}</div>
        <div class="editor prose" contenteditable="true"
             data-placeholder="이 여백에 배운 것을 자유롭게 적어 보세요. 사진은 붙여넣거나 끌어다 놓으면 됩니다."></div>
        <div class="editor-foot">
          <div class="editor-status">
            <span class="count">0자</span>
            <span class="draft-status"></span>
          </div>
          <button type="button" class="btn cancel-btn">돌아가기</button>
          <button type="button" class="btn btn-primary save-btn">여백에 담기</button>
        </div>
        <input type="file" class="file-input" accept="image/*" multiple hidden>
      </section>
    `;

    editorEl = $('.editor');
    titleEl = $('.title-input');
    tagInputEl = $('.tag-input');
    chipsEl = $('.chips');
    countEl = $('.count');
    draftStatusEl = $('.draft-status');
    fileInputEl = $('.file-input');
    saveBtnEl = $('.save-btn');

    if (note) editorEl.innerHTML = sanitize(note.html);
    setLineHeight(note && note.lineHeight ? note.lineHeight : 'normal');

    try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch (e) { /* 무시 */ }

    renderChips();
    updateCount();
    bindEvents();
    maybeOfferDraft();

    if (!note) titleEl.focus();
  }

  function unmount() {
    mountGen++;
    closeMenu();
    // 예약만 되고 아직 실행되지 않은 임시저장은 떠나기 전에 마저 해 둔다
    if (draftPending && editorEl) {
      clearTimeout(draftTimer);
      draftSave();
    }
    clearTimeout(draftTimer);
    draftPending = false;
    if (keydownHandler) {
      document.removeEventListener('keydown', keydownHandler);
      keydownHandler = null;
    }
    if (beforeUnloadHandler) {
      window.removeEventListener('beforeunload', beforeUnloadHandler);
      beforeUnloadHandler = null;
    }
    savedRange = null;
    root = null;
  }

  /* ---------- 태그 ---------- */
  function renderChips() {
    chipsEl.innerHTML = tags.map((t, i) =>
      `<span class="tag-chip">${esc(t)}<button type="button" data-i="${i}" title="태그 지우기" aria-label="${esc(t)} 태그 지우기">×</button></span>`
    ).join('');
    chipsEl.querySelectorAll('button').forEach(b => {
      b.addEventListener('click', () => {
        tags.splice(Number(b.dataset.i), 1);
        renderChips();
        scheduleDraft();
      });
    });
  }

  function addTagsFromInput() {
    const parts = tagInputEl.value.split(',').map(s => s.trim().replace(/^#/, '')).filter(Boolean);
    for (const p of parts) {
      if (!tags.includes(p) && tags.length < 12) tags.push(p);
    }
    tagInputEl.value = '';
    renderChips();
    scheduleDraft();
  }

  /* ---------- 서식 명령 ---------- */
  function exec(cmd, value) {
    editorEl.focus();
    try { document.execCommand(cmd, false, value); } catch (e) { /* 무시 */ }
  }

  function currentBlockTag() {
    const sel = window.getSelection();
    if (!sel.rangeCount) return null;
    let node = sel.getRangeAt(0).startContainer;
    while (node && node !== editorEl) {
      if (node.nodeType === 1 && /^(H2|H3|BLOCKQUOTE|PRE)$/.test(node.tagName)) return node.tagName;
      node = node.parentNode;
    }
    return null;
  }

  function toggleBlock(tag) {
    const cur = currentBlockTag();
    exec('formatBlock', cur === tag.toUpperCase() ? '<p>' : '<' + tag + '>');
  }

  function findAncestor(tagName) {
    const sel = window.getSelection();
    if (!sel.rangeCount) return null;
    let node = sel.getRangeAt(0).commonAncestorContainer;
    while (node && node !== editorEl) {
      if (node.nodeType === 1 && node.tagName === tagName) return node;
      node = node.parentNode;
    }
    return null;
  }

  function toggleMark() {
    editorEl.focus();
    const existing = findAncestor('MARK');
    if (existing) {
      // <mark>를 벗겨 낸다
      const parent = existing.parentNode;
      while (existing.firstChild) parent.insertBefore(existing.firstChild, existing);
      parent.removeChild(existing);
      handleChange();
      return;
    }
    const sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    try {
      const mark = document.createElement('mark');
      range.surroundContents(mark);
      sel.removeAllRanges();
    } catch (e) {
      // 선택이 여러 요소에 걸치면 내용을 꺼내 감싼다
      try {
        const mark = document.createElement('mark');
        mark.appendChild(range.extractContents());
        range.insertNode(mark);
        sel.removeAllRanges();
      } catch (e2) { /* 포기 */ }
    }
    handleChange();
  }

  /** 이 글 전체의 줄 간격을 바꾼다 */
  function setLineHeight(v) {
    if (!LINE_HEIGHTS.includes(v)) v = 'normal';
    lineHeight = v;
    if (editorEl) {
      editorEl.classList.remove('lh-tight', 'lh-loose');
      if (v !== 'normal') editorEl.classList.add('lh-' + v);
    }
  }

  /**
   * 편집기 맨 위층의 맨몸 글(문단 태그 없이 놓인 텍스트)을 <p>로 감싼다.
   * contenteditable은 첫 줄을 문단으로 감싸지 않는 일이 있어,
   * 문단 단위 서식을 주기 전에 고르게 만들어 둔다.
   */
  const TOP_BLOCK_TAGS = new Set(['P', 'H2', 'H3', 'UL', 'OL', 'BLOCKQUOTE', 'PRE', 'FIGURE', 'TABLE', 'HR', 'DIV']);
  function normalizeBlocks() {
    const kids = [...editorEl.childNodes];
    let run = [];
    const flush = (before) => {
      if (!run.length) return;
      const hasContent = run.some(n => n.nodeType === 1 || (n.textContent && n.textContent.trim()));
      if (hasContent) {
        const p = document.createElement('p');
        editorEl.insertBefore(p, before);
        run.forEach(n => p.appendChild(n));
      }
      run = [];
    };
    for (const n of kids) {
      if (n.nodeType === 1 && TOP_BLOCK_TAGS.has(n.tagName)) flush(n);
      else run.push(n);
    }
    flush(null);
  }

  /** 고른 문단(또는 커서가 있는 문단)의 줄 간격만 바꾼다 */
  const LH_BLOCK_TAGS = 'p,h2,h3,li,blockquote,pre';
  function applyBlockLineHeight(v) {
    editorEl.focus();
    restoreSelection();
    const sel = window.getSelection();
    if (!sel.rangeCount || !editorEl.contains(sel.getRangeAt(0).commonAncestorContainer)) {
      UI.toast('간격을 바꿀 문단에 커서를 두거나, 여러 문단을 골라 주세요.');
      return;
    }
    const range = sel.getRangeAt(0);

    // 정규화가 노드를 옮기면 Range 기준점이 밀려나므로,
    // 옮기기 전에 선택이 걸친 것들을 먼저 기억해 둔다.
    const priorBlocks = [...editorEl.querySelectorAll(LH_BLOCK_TAGS)].filter(b => range.intersectsNode(b));
    const bareTouched = [...editorEl.childNodes].filter(n =>
      !(n.nodeType === 1 && TOP_BLOCK_TAGS.has(n.tagName)) && range.intersectsNode(n));

    normalizeBlocks();

    const blockSet = new Set(priorBlocks.filter(b => editorEl.contains(b)));
    for (const n of bareTouched) {
      const el = n.nodeType === 1 ? n : n.parentElement;
      const block = el && el.closest ? el.closest(LH_BLOCK_TAGS) : null;
      if (block && editorEl.contains(block)) blockSet.add(block);
    }

    if (!blockSet.size) {
      UI.toast('간격을 바꿀 문단을 찾지 못했습니다.');
      return;
    }
    blockSet.forEach(b => {
      b.classList.remove('lh-tight', 'lh-loose');
      if (v === 'tight' || v === 'loose') b.classList.add('lh-' + v);
      if (!b.classList.length) b.removeAttribute('class');
    });
    handleChange();
  }

  function unwrapEl(el) {
    const parent = el.parentNode;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
  }

  /** 감싼 조각 안에 크기 스팬이 겹겹이 쌓이지 않게 안쪽 것들을 벗긴다 */
  function stripNestedSizes(container) {
    container.querySelectorAll('span').forEach(s => {
      if (SIZE_CLASSES.some(c => s.classList.contains(c))) unwrapEl(s);
    });
  }

  /** 고른 부분의 글자 크기를 바꾼다(cls가 비면 보통으로 되돌린다) */
  function applySize(cls) {
    editorEl.focus();
    restoreSelection();
    const sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed ||
        !editorEl.contains(sel.getRangeAt(0).commonAncestorContainer)) {
      UI.toast('크기를 바꿀 부분을 먼저 골라 주세요.');
      return;
    }
    const range = sel.getRangeAt(0);

    // 이미 크기 스팬 안에서 골랐다면 그 스팬을 고치거나 벗긴다
    let node = range.commonAncestorContainer;
    while (node && node !== editorEl) {
      if (node.nodeType === 1 && node.tagName === 'SPAN' &&
          SIZE_CLASSES.some(c => node.classList.contains(c))) break;
      node = node.parentNode;
    }
    if (node && node !== editorEl) {
      if (cls) node.className = cls;
      else unwrapEl(node);
      sel.removeAllRanges();
      handleChange();
      return;
    }

    if (!cls) return; // 되돌릴 크기 스팬이 없다

    const wrap = () => {
      const s = document.createElement('span');
      s.className = cls;
      return s;
    };
    try {
      const s = wrap();
      range.surroundContents(s);
      stripNestedSizes(s);
      sel.removeAllRanges();
    } catch (e) {
      // 선택이 여러 요소에 걸치면 내용을 꺼내 감싼다
      try {
        const s = wrap();
        s.appendChild(range.extractContents());
        stripNestedSizes(s);
        range.insertNode(s);
        sel.removeAllRanges();
      } catch (e2) { /* 포기 */ }
    }
    handleChange();
  }

  function saveSelection() {
    const sel = window.getSelection();
    savedRange = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
  }

  function restoreSelection() {
    if (!savedRange) return;
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(savedRange);
  }

  /** 좌표(끌어다 놓은 지점)에서 캐럿 위치를 구한다 */
  function rangeFromPoint(x, y) {
    if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      if (!p) return null;
      const r = document.createRange();
      r.setStart(p.offsetNode, p.offset);
      r.collapse(true);
      return r;
    }
    return null;
  }

  function askLink() {
    saveSelection();
    const gen = mountGen;
    UI.promptModal({
      title: '링크 걸기',
      placeholder: 'https://…',
      okText: '걸기',
    }).then(url => {
      if (gen !== mountGen) return; // 그 사이 화면이 바뀌었다
      if (!url) return;
      let href = url.trim();
      if (!/^(https?:|mailto:|#)/i.test(href)) href = 'https://' + href;
      editorEl.focus();
      restoreSelection();
      const sel = window.getSelection();
      if (!sel.rangeCount || sel.isCollapsed) {
        exec('insertHTML', `<a href="${esc(href)}">${esc(href)}</a>`);
      } else {
        exec('createLink', href);
      }
      handleChange();
    });
  }

  async function insertFiles(files) {
    const gen = mountGen;
    const images = [...files].filter(f => f.type && f.type.startsWith('image/'));
    if (!images.length) return;
    pendingImages += images.length;
    UI.toast(images.length > 1 ? `사진 ${images.length}장을 담는 중…` : '사진을 담는 중…');
    for (const file of images) {
      try {
        const dataUrl = await compressImage(file);
        if (gen !== mountGen) return; // 화면이 바뀌었으면 조용히 중단
        editorEl.focus();
        restoreSelection();
        exec('insertHTML', `<figure><img src="${dataUrl}" alt="${esc(file.name.replace(/\.[^.]+$/, ''))}"></figure><p><br></p>`);
        saveSelection();
      } catch (e) {
        if (gen !== mountGen) return;
        if (e && e.code === 'unsupported') {
          UI.toast(`'${file.name}' — 브라우저가 읽지 못하는 사진 형식입니다. JPG나 PNG로 바꿔 넣어 주세요.`);
        } else if (e && e.code === 'too-big') {
          UI.toast('움직이는 그림이 너무 커서 담지 못했습니다. (4MB까지)');
        } else {
          UI.toast('사진을 넣지 못했습니다.');
        }
      } finally {
        if (gen === mountGen) pendingImages = Math.max(0, pendingImages - 1);
      }
    }
    if (gen === mountGen) handleChange();
  }

  function runTool(cmd) {
    switch (cmd) {
      case 'h2': toggleBlock('h2'); break;
      case 'h3': toggleBlock('h3'); break;
      case 'bold': exec('bold'); break;
      case 'italic': exec('italic'); break;
      case 'underline': exec('underline'); break;
      case 'strike': exec('strikeThrough'); break;
      case 'mark': toggleMark(); break;
      case 'quote': toggleBlock('blockquote'); break;
      case 'ul': exec('insertUnorderedList'); break;
      case 'ol': exec('insertOrderedList'); break;
      case 'code': toggleBlock('pre'); break;
      case 'hr': exec('insertHTML', '<hr><p><br></p>'); break;
      case 'link': askLink(); break;
      case 'image': saveSelection(); fileInputEl.click(); break;
    }
    if (cmd !== 'link' && cmd !== 'image') handleChange();
  }

  /* ---------- 임시저장 ---------- */
  function loadKey(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function removeKey(key) {
    try { localStorage.removeItem(key); } catch (e) { /* 무시 */ }
  }

  /** 되살릴 가치가 있는 임시저장인가(제목·본문 글자·사진·태그 중 하나라도) */
  function draftMeaningful(d) {
    if (!d) return false;
    if (d.title && d.title.trim()) return true;
    if (Array.isArray(d.tags) && d.tags.length) return true;
    const html = d.html || '';
    if (htmlToText(html)) return true;
    if (/<img[\s>]/i.test(html)) return true;
    return false;
  }

  function draftSave() {
    if (!root || !editorEl) return;
    // 아직 결정을 못 받은 이전 임시저장은 덮어쓰기 전에 따로 옮겨 둔다
    if (pendingOldDraft) {
      try { localStorage.setItem(draftKey + '.bak', JSON.stringify(pendingOldDraft)); } catch (e) { /* 무시 */ }
      pendingOldDraft = null;
    }
    draftPending = false;
    try {
      localStorage.setItem(draftKey, JSON.stringify({
        title: titleEl.value,
        html: editorEl.innerHTML,
        tags,
        lineHeight,
        at: Date.now(),
      }));
      draftStatusEl.textContent = '임시저장 ' + new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
    } catch (e) {
      // 사진이 커서 localStorage 한도를 넘으면 조용히 넘어간다(정식 저장은 IndexedDB)
      draftStatusEl.textContent = '';
    }
  }

  function draftClear() {
    removeKey(draftKey);
  }

  function scheduleDraft() {
    draftPending = true;
    clearTimeout(draftTimer);
    draftTimer = setTimeout(draftSave, 900);
  }

  function maybeOfferDraft() {
    // 본 키를 먼저 보고, 새 글이라면 이전에 밀려난 갈피(.bak)도 살핀다
    let key = draftKey;
    let draft = loadKey(key);
    if (draft && !draftMeaningful(draft)) { removeKey(key); draft = null; }
    if (draft && note && !(draft.at > note.updatedAt)) { removeKey(key); draft = null; }

    if (!draft && !note) {
      const bak = loadKey(draftKey + '.bak');
      if (draftMeaningful(bak)) {
        key = draftKey + '.bak';
        draft = bak;
      } else if (bak !== null) {
        removeKey(draftKey + '.bak');
      }
    }
    if (!draft) return;

    // 본 키의 임시저장은 새로 쓰는 글이 덮어쓸 수 있으니, 덮기 직전에 .bak으로 대피시킨다
    pendingOldDraft = (key === draftKey) ? draft : null;

    const slot = $('.draft-slot');
    const when = new Date(draft.at).toLocaleString('ko-KR', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    slot.innerHTML = `
      <div class="draft-banner">
        <span>${when}에 쓰다 만 글이 있습니다.</span>
        <button type="button" class="draft-restore">이어서 쓰기</button>
        <button type="button" class="draft-discard">버리기</button>
      </div>`;
    slot.querySelector('.draft-restore').addEventListener('click', () => {
      titleEl.value = draft.title || '';
      editorEl.innerHTML = sanitize(draft.html || '');
      tags = Array.isArray(draft.tags) ? draft.tags.filter(t => typeof t === 'string') : [];
      setLineHeight(draft.lineHeight || 'normal');
      renderChips();
      updateCount();
      pendingOldDraft = null;
      if (key !== draftKey) removeKey(key); // 갈피에서 되살렸으면 갈피는 비운다
      slot.innerHTML = '';
    });
    slot.querySelector('.draft-discard').addEventListener('click', () => {
      removeKey(key);
      pendingOldDraft = null;
      slot.innerHTML = '';
    });
  }

  /* ---------- 저장 ---------- */
  function updateCount() {
    const n = (editorEl.textContent || '').replace(/\s+/g, ' ').trim().length;
    countEl.textContent = n.toLocaleString('ko-KR') + '자';
  }

  function handleChange() {
    updateCount();
    scheduleDraft();
  }

  async function save() {
    if (saving) return;
    if (pendingImages > 0) {
      UI.toast('사진을 담는 중입니다. 끝나면 다시 저장해 주세요.');
      return;
    }
    addTagsFromInput(); // 입력창에 남아 있는 태그도 거둔다
    const title = titleEl.value.trim();
    if (!title) {
      titleEl.classList.remove('shake');
      void titleEl.offsetWidth;
      titleEl.classList.add('shake');
      titleEl.focus();
      UI.toast('표제어를 먼저 적어 주세요.');
      return;
    }

    saving = true;
    if (saveBtnEl) saveBtnEl.disabled = true;

    try {
      const html = sanitize(editorEl.innerHTML);
      const text = htmlToText(html);
      const now = Date.now();
      const saved = {
        id: note ? note.id : UI.uuid(),
        title,
        html,
        text,
        tags: [...tags],
        lineHeight,
        createdAt: note ? note.createdAt : now,
        updatedAt: now,
      };

      await DB.put(saved); // 트랜잭션 커밋까지 확인된 뒤에야 성공이다
      note = saved;        // 연이어 저장해도 같은 글로 갱신되게
      clearTimeout(draftTimer);
      draftPending = false; // 방금 담은 글이 임시저장으로 되살아나지 않게
      draftClear();
      if (onSaveCb) onSaveCb(saved);
    } catch (e) {
      UI.toast('저장하지 못했습니다. 저장 공간이 부족할 수 있습니다 — 서랍에서 내보내기로 갈무리해 주세요.');
    } finally {
      saving = false;
      if (saveBtnEl && saveBtnEl.isConnected) saveBtnEl.disabled = false;
    }
  }

  /* ---------- 도구막대 메뉴(팝오버) ---------- */
  let popEl = null, popBtn = null;

  function closeMenu() {
    if (popEl) { popEl.remove(); popEl = null; }
    if (popBtn) { popBtn.setAttribute('aria-expanded', 'false'); popBtn = null; }
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onPopKey, true);
    window.removeEventListener('scroll', positionMenu, true);
    window.removeEventListener('resize', positionMenu);
  }

  /** 팝오버를 단추 아래, 화면 밖으로 나가지 않게 놓는다(스크롤하면 따라간다) */
  function positionMenu() {
    if (!popEl) return;
    if (!popBtn || !popBtn.isConnected) { closeMenu(); return; }
    const r = popBtn.getBoundingClientRect();
    popEl.style.top = (r.bottom + 6) + 'px';
    let left = r.left;
    if (left + popEl.offsetWidth > window.innerWidth - 8) {
      left = window.innerWidth - popEl.offsetWidth - 8;
    }
    popEl.style.left = Math.max(8, left) + 'px';
  }

  function onDocDown(e) {
    if (popEl && !popEl.contains(e.target) && popBtn && !popBtn.contains(e.target)) closeMenu();
  }

  function onPopKey(e) {
    if (!popEl) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      const b = popBtn;
      closeMenu();
      if (b) b.focus();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const items = [...popEl.querySelectorAll('.pop-item')];
      if (!items.length) return;
      const i = items.indexOf(document.activeElement);
      const n = e.key === 'ArrowDown'
        ? (i + 1) % items.length
        : (i - 1 + items.length) % items.length;
      items[n].focus();
    }
  }

  function buildSizePop() {
    const items = [
      ['t-sm', '작게', '0.85em'],
      ['', '보통', '1em'],
      ['t-lg', '크게', '1.18em'],
      ['t-xl', '아주 크게', '1.35em'],
    ];
    return items.map(([v, label, size]) =>
      `<button type="button" class="pop-item" role="menuitem" data-size="${v}"><span style="font-size:${size}">${label}</span></button>`
    ).join('');
  }

  function buildLhPop() {
    const row = (attr, current) => ['tight', 'normal', 'loose'].map(v => {
      const names = { tight: '좁게', normal: '보통', loose: '넓게' };
      return `<button type="button" class="pop-item${current === v ? ' on' : ''}" role="menuitem" data-${attr}="${v}">${names[v]}</button>`;
    }).join('');
    return `
      <div class="pop-label">고른 부분만</div>
      <div class="pop-row">${row('lhsel', null)}</div>
      <div class="pop-label">글 전체</div>
      <div class="pop-row">${row('lhdoc', lineHeight)}</div>`;
  }

  function openMenu(btn, kind) {
    if (popEl && popBtn === btn) { closeMenu(); return; } // 같은 단추를 다시 누르면 닫는다
    closeMenu();
    saveSelection(); // 메뉴를 여는 순간의 선택을 보관
    popBtn = btn;
    btn.setAttribute('aria-expanded', 'true');

    popEl = document.createElement('div');
    popEl.className = 'tool-pop';
    popEl.setAttribute('role', 'menu');
    popEl.innerHTML = kind === 'size' ? buildSizePop() : buildLhPop();
    document.body.appendChild(popEl);
    positionMenu();

    // 항목을 눌러도 편집기의 선택이 풀리지 않게
    popEl.querySelectorAll('button').forEach(b => b.addEventListener('mousedown', e => e.preventDefault()));
    popEl.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.size !== undefined) applySize(b.dataset.size);
      else if (b.dataset.lhsel) applyBlockLineHeight(b.dataset.lhsel);
      else if (b.dataset.lhdoc) { setLineHeight(b.dataset.lhdoc); scheduleDraft(); }
      closeMenu();
    });

    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('keydown', onPopKey, true);
    window.addEventListener('scroll', positionMenu, true);
    window.addEventListener('resize', positionMenu);
  }

  /* ---------- 사건 연결 ---------- */
  function bindEvents() {
    const toolButtons = [...root.querySelectorAll('.tool')];
    toolButtons.forEach((btn, i) => {
      // mousedown에서 초점을 잃지 않게 막는다
      btn.addEventListener('mousedown', e => e.preventDefault());
      btn.addEventListener('click', () => {
        if (btn.dataset.menu) openMenu(btn, btn.dataset.menu);
        else runTool(btn.dataset.cmd);
      });
      btn.tabIndex = i === 0 ? 0 : -1; // 도구막대 전체가 Tab 정거장 하나가 되도록
    });

    // 도구막대 안에서는 좌우 화살표로 옮겨 다닌다
    $('.toolbar').addEventListener('keydown', e => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      const cur = toolButtons.indexOf(document.activeElement);
      let next = cur < 0 ? 0 : cur;
      if (e.key === 'ArrowLeft') next = cur <= 0 ? toolButtons.length - 1 : cur - 1;
      if (e.key === 'ArrowRight') next = cur >= toolButtons.length - 1 ? 0 : cur + 1;
      if (e.key === 'Home') next = 0;
      if (e.key === 'End') next = toolButtons.length - 1;
      toolButtons.forEach((b, i) => { b.tabIndex = i === next ? 0 : -1; });
      toolButtons[next].focus();
    });

    editorEl.addEventListener('input', handleChange);
    titleEl.addEventListener('input', scheduleDraft);

    tagInputEl.addEventListener('keydown', e => {
      if (e.isComposing || e.keyCode === 229) return; // 한글 조합 중의 키는 건드리지 않는다
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        addTagsFromInput();
      } else if (e.key === 'Backspace' && !tagInputEl.value && tags.length) {
        tags.pop();
        renderChips();
        scheduleDraft();
      }
    });
    tagInputEl.addEventListener('blur', () => {
      if (tagInputEl.value.trim()) addTagsFromInput();
    });

    // 붙여넣기: 사진은 압축해 넣고, 서식 있는 글은 정돈해 넣는다
    editorEl.addEventListener('paste', e => {
      const items = e.clipboardData && e.clipboardData.items;
      if (items) {
        const files = [...items].filter(i => i.kind === 'file' && i.type.startsWith('image/')).map(i => i.getAsFile()).filter(Boolean);
        if (files.length) {
          e.preventDefault();
          saveSelection();
          insertFiles(files);
          return;
        }
      }
      const html = e.clipboardData && e.clipboardData.getData('text/html');
      if (html) {
        e.preventDefault();
        exec('insertHTML', sanitize(html));
        handleChange();
      }
      // 순수 글자는 브라우저 기본 동작에 맡긴다
    });

    // 끌어다 놓기 — 놓은 자리에 들어가도록 좌표에서 캐럿을 구한다
    editorEl.addEventListener('dragover', e => {
      if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) {
        e.preventDefault();
        editorEl.classList.add('dragover');
      }
    });
    editorEl.addEventListener('dragleave', () => editorEl.classList.remove('dragover'));
    editorEl.addEventListener('drop', e => {
      editorEl.classList.remove('dragover');
      if (e.dataTransfer && e.dataTransfer.files.length) {
        e.preventDefault();
        const r = rangeFromPoint(e.clientX, e.clientY);
        if (r && editorEl.contains(r.startContainer)) {
          savedRange = r;
        } else {
          saveSelection();
        }
        insertFiles(e.dataTransfer.files);
      }
    });

    fileInputEl.addEventListener('change', () => {
      if (fileInputEl.files.length) insertFiles(fileInputEl.files);
      fileInputEl.value = '';
    });

    saveBtnEl.addEventListener('click', save);
    $('.cancel-btn').addEventListener('click', () => {
      // 앱 안에서 돌아다닌 이력이 있을 때만 뒤로 간다(밖에서 바로 들어왔으면 홈으로)
      let canBack = false;
      try { canBack = typeof App !== 'undefined' && App.canGoBack(); } catch (e) { /* 무시 */ }
      if (canBack) history.back();
      else location.hash = '#/';
    });

    keydownHandler = (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.repeat && e.key.toLowerCase() === 's') {
        e.preventDefault();
        save();
      }
    };
    document.addEventListener('keydown', keydownHandler);

    // 창을 닫거나 새로 고칠 때, 기다리던 임시저장을 마저 해 둔다
    beforeUnloadHandler = () => {
      if (draftPending) {
        clearTimeout(draftTimer);
        draftSave();
      }
    };
    window.addEventListener('beforeunload', beforeUnloadHandler);
  }

  return { mount, unmount, sanitize, htmlToText };
})();
