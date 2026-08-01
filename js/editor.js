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
    SPAN: ['class'],
    // DIV는 일부러 뺐다 — 아래에서 <p>로 바꾸거나 벗긴다
  };
  // 덩이(블록) 요소 — 문단 간격과 줄 간격의 단위
  const BLOCK_TAGS = new Set([
    'P', 'H2', 'H3', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'FIGURE',
    'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD', 'HR', 'DIV',
  ]);
  // class는 서식 용도로만 허용한다: span은 글자 크기, 문단은 줄 간격
  const SIZE_CLASSES = ['t-sm', 't-lg', 't-xl'];
  // lh-normal은 '글 전체 설정을 따르지 말고 보통으로 못 박기'를 뜻한다.
  // 이것이 없으면 「보통」이 클래스를 지우기만 해서 글 전체 값을 도로 물려받는다.
  const LH_CLASSES = ['lh-tight', 'lh-normal', 'lh-loose'];
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

        // <div>에는 문단 여백 규칙이 없어 그 자리만 바싹 붙어 보인다(붙여넣기가 자주 만든다).
        // 인라인만 담고 있으면 <p>로 바꾸고, 블록을 담고 있으면 벗겨 낸다.
        if (tag === 'DIV') {
          const hasBlock = [...child.childNodes]
            .some(n => n.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has(n.tagName));
          if (hasBlock || !child.firstChild) {
            while (child.firstChild) node.insertBefore(child.firstChild, child);
          } else {
            const p = doc.createElement('p');
            while (child.firstChild) p.appendChild(child.firstChild);
            node.insertBefore(p, child);
          }
          child.remove();
          continue;
        }

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

  /* ---------- 붙임 파일 ---------- */
  const FILE_MAX = 25 * 1024 * 1024;        // 파일 하나 상한
  const FILES_TOTAL_MAX = 60 * 1024 * 1024; // 한 글의 붙임 합계 상한
  const FILES_COUNT_MAX = 20;

  /**
   * 내려받을 때 쓸 형식.
   * html·svg 같은 것은 우리 주소 안에서 스크립트로 살아날 수 있으므로,
   * 미리 안전하다고 아는 형식이 아니면 중립 형식으로 내려 준다.
   */
  const SAFE_TYPES = /^(image\/(png|jpeg|gif|webp|avif|bmp)|application\/pdf|text\/plain|audio\/|video\/)/i;
  function downloadType(type) {
    return SAFE_TYPES.test(type || '') ? type : 'application/octet-stream';
  }

  /** 경로 구분자·제어문자를 걷어 낸 파일 이름 */
  function safeFileName(name) {
    const s = String(name || '').replace(/[\\/\u0000-\u001f\u007f]/g, '_').trim().slice(0, 120);
    return s || '파일';
  }

  function fmtSize(n) {
    const v = Number(n) || 0;
    if (v < 1024) return v + 'B';
    if (v < 1024 * 1024) return Math.round(v / 1024) + 'KB';
    return (v / 1048576).toFixed(1) + 'MB';
  }

  const objectUrls = new Set();
  function objectUrlFor(blob) {
    const u = URL.createObjectURL(blob);
    objectUrls.add(u);
    return u;
  }

  function revokeUrl(u) {
    objectUrls.delete(u);
    try { URL.revokeObjectURL(u); } catch (e) { /* 무시 */ }
  }

  function revokeObjectUrls() {
    [...objectUrls].forEach(revokeUrl);
  }

  /** 붙임 파일을 내려받는다(열람 화면에서도 쓴다) */
  async function downloadFile(id, name) {
    let rec = null;
    try { rec = await DB.getFile(id); } catch (e) { /* 무시 */ }
    if (!rec || !rec.blob) { UI.toast('파일을 찾지 못했습니다.'); return; }
    const type = downloadType(rec.type);
    const blob = rec.blob.type === type ? rec.blob : new Blob([rec.blob], { type });
    const url = objectUrlFor(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = safeFileName(name || rec.name);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => revokeUrl(url), 4000);
  }

  /* ---------- 편집기 상태 ---------- */
  let root = null;
  let editorEl = null, titleEl = null, tagInputEl = null, chipsEl = null;
  let countEl = null, draftStatusEl = null, fileInputEl = null, saveBtnEl = null;
  let filesEl = null, fileAnyEl = null;
  let note = null;        // 수정 대상(새 글이면 null)
  let tags = [];
  let onSaveCb = null;
  let draftKey = 'yeobaeck.draft.new';
  let draftTimer = null;
  let draftPending = false;      // 예약된 임시저장이 아직 실행되지 않았는가
  let pendingOldDraft = null;    // 배너로 안내했지만 아직 결정되지 않은 이전 임시저장
  let keydownHandler = null;
  let beforeUnloadHandler = null;
  let selectionHandler = null;
  let navGuard = null;
  let composing = false;  // 한글 조합 중에는 도구막대를 흔들지 않는다
  let savedRange = null;  // 모달이 초점을 가져갈 때 선택 영역 보관
  let mountGen = 0;       // 세대 토큰 — 화면이 바뀐 뒤 도착한 비동기 작업을 무시하기 위함
  let saving = false;
  let pendingImages = 0;  // 압축 중인 사진 수
  let lineHeight = 'normal'; // 이 글의 줄 간격 (tight | normal | loose)
  const LINE_HEIGHTS = ['tight', 'normal', 'loose'];
  let attachments = [];   // 이 글에 딸린 붙임 파일 정보 {id, name, type, size, addedAt}
  let noteId = null;      // 이 글의 이름표(붙임을 먼저 담아 두려면 저장 전에도 있어야 한다)
  let baseline = null;    // 담긴 것과 견줄 밑그림 — 고친 게 있는지 가리는 잣대
  let leaving = false;    // 확인창을 이미 지나 나가는 중
  let editorHash = '#/';  // 편집기가 놓인 주소(붙잡을 때 되돌릴 자리)

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
  const SVG_CLIP = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 9.2l-4.9 4.9a3.1 3.1 0 0 1-4.4-4.4l5.6-5.6a2.1 2.1 0 0 1 3 3l-5.6 5.6a1.1 1.1 0 0 1-1.5-1.5l4.9-4.9"/></svg>';

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
    { cmd: 'file', label: SVG_CLIP, title: '파일 붙이기 — 글과 함께 보관합니다' },
  ];

  /* ---------- 그리기 ---------- */
  function mount(container, existingNote, opts) {
    mountGen++;
    root = container;
    note = existingNote || null;
    tags = note ? [...(note.tags || [])] : [];
    onSaveCb = opts && opts.onSave;
    // 새 글은 임시저장 열쇠를 'new' 하나로 함께 쓴다 — 열쇠를 새 이름표로 나누면
    // 「이어서 쓰기」가 지난 글을 영영 찾지 못하고 찌꺼기만 쌓인다.
    draftKey = 'yeobaeck.draft.' + (note ? note.id : 'new');
    saving = false;
    pendingImages = 0;
    draftPending = false;
    pendingOldDraft = null;
    savedRange = null;
    noteId = note ? note.id : null;
    attachments = note ? [...(note.files || [])] : [];
    baseline = null;
    leaving = false;
    editorHash = location.hash || '#/';

    const toolsHtml = TOOLS.map(t => {
      if (t.sep) return '<span class="sep"></span>';
      if (t.menu) {
        return `<button type="button" class="tool tool-menu-btn" data-menu="${t.menu}" title="${esc(t.title)}" aria-label="${esc(t.title)}" aria-haspopup="menu" aria-expanded="false">${esc(t.label)}<span class="menu-now"></span><span class="menu-caret" aria-hidden="true">▾</span></button>`;
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
        <div class="editor-files"></div>
        <div class="editor-foot">
          <div class="editor-status">
            <span class="count">0자</span>
            <span class="draft-status"></span>
          </div>
          <button type="button" class="btn cancel-btn">돌아가기</button>
          <button type="button" class="btn btn-primary save-btn">여백에 담기</button>
        </div>
        <input type="file" class="file-input" accept="image/*" multiple hidden>
        <input type="file" class="file-any" multiple hidden>
      </section>
    `;

    editorEl = $('.editor');
    titleEl = $('.title-input');
    tagInputEl = $('.tag-input');
    chipsEl = $('.chips');
    countEl = $('.count');
    draftStatusEl = $('.draft-status');
    fileInputEl = $('.file-input');
    fileAnyEl = $('.file-any');
    filesEl = $('.editor-files');
    saveBtnEl = $('.save-btn');

    if (note) editorEl.innerHTML = sanitize(note.html);
    setLineHeight(note && note.lineHeight ? note.lineHeight : 'normal');

    try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch (e) { /* 무시 */ }

    renderChips();
    renderFiles();
    updateCount();
    bindEvents();
    baseline = snapshot();   // 여기까지가 '담겨 있던 모습' — 이 뒤로 달라지면 고친 것이다
    maybeOfferDraft();
    updateToolbarState();

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
    // 담지 않고 떠나면서 붙임만 남았다면, 임시저장이 그 이름표를 붙들고 있지 않은 한 치운다
    // (붙들고 있다면 「이어서 쓰기」로 되찾을 수 있어야 하고, 그마저 버려지면 청소가 맡는다)
    if (!note && noteId && attachments.length) {
      const d = loadKey(draftKey);
      if (!(d && d.id === noteId)) DB.delFilesOf(noteId).catch(() => { /* 청소가 마저 맡는다 */ });
    }
    attachments = [];
    noteId = null;
    if (keydownHandler) {
      document.removeEventListener('keydown', keydownHandler);
      keydownHandler = null;
    }
    if (beforeUnloadHandler) {
      window.removeEventListener('beforeunload', beforeUnloadHandler);
      beforeUnloadHandler = null;
    }
    if (selectionHandler) {
      document.removeEventListener('selectionchange', selectionHandler);
      selectionHandler = null;
    }
    if (navGuard) {
      document.removeEventListener('click', navGuard, true);
      navGuard = null;
    }
    revokeObjectUrls();
    baseline = null;
    leaving = false;
    if (stateRaf) { cancelAnimationFrame(stateRaf); stateRaf = 0; }
    composing = false;
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

  /* ---------- 선택 영역 다루기 ---------- */

  /**
   * 노드가 범위와 '폭을 가지고' 겹치는가.
   * Range.intersectsNode는 경계에 닿기만 해도 참이라, 선택이 다음 문단
   * 첫머리에서 끝나면 그 문단까지 잡혔다 — 위·아래 문단이 딸려 오던 까닭이다.
   */
  function strictlyOverlaps(node, range) {
    let r;
    try {
      r = document.createRange();
      r.selectNodeContents(node);
    } catch (e) { return false; }
    return range.compareBoundaryPoints(Range.END_TO_START, r) < 0 &&
           range.compareBoundaryPoints(Range.START_TO_END, r) > 0;
  }

  /** 범위 양 끝에 걸친 글자 노드를 갈라, 범위 안 노드가 모두 '통째로' 들어오게 한다 */
  function splitBoundaries(range) {
    const ec = range.endContainer, eo = range.endOffset;
    if (ec.nodeType === Node.TEXT_NODE && eo > 0 && eo < ec.length) ec.splitText(eo);
    const sc = range.startContainer, so = range.startOffset;
    if (sc.nodeType === Node.TEXT_NODE && so > 0 && so < sc.length) sc.splitText(so);
  }

  // 이 태그들 사이에 낀 공백은 서식을 씌워도 보이지 않고 지저분해지기만 한다
  const WS_HOLDERS = new Set(['UL', 'OL', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'FIGURE']);

  /** 범위 안에 온전히 들어온 글자 노드들 (문서에 놓인 차례대로) */
  function textNodesIn(range) {
    let root = range.commonAncestorContainer;
    if (root.nodeType !== Node.ELEMENT_NODE) root = root.parentNode;
    if (!root || !editorEl.contains(root)) return [];
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    let n;
    while ((n = walker.nextNode())) {
      if (!n.nodeValue) continue;
      const holder = n.parentNode;
      if (!n.nodeValue.trim() && (holder === editorEl || WS_HOLDERS.has(holder.tagName))) continue;
      if (strictlyOverlaps(n, range)) out.push(n);
    }
    return out;
  }

  /* ---------- 서식 갈래 ---------- */
  // 형광펜과 글자 크기는 '고른 부분만 감싼다'는 점이 같아 한 길로 모은다.
  const KINDS = {
    mark: {
      is: (el) => el.tagName === 'MARK',
      make: () => document.createElement('mark'),
      same: () => true,
    },
    size: {
      is: (el) => el.tagName === 'SPAN' && SIZE_CLASSES.some(c => el.classList.contains(c)),
      make: (v) => { const s = document.createElement('span'); s.className = v; return s; },
      same: (a, b) => a.className === b.className,
    },
  };
  const KIND_SELECTOR = 'mark, span';

  function unwrapEl(el) {
    const parent = el.parentNode;
    if (!parent) return;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
  }

  function kindOf(el) {
    if (KINDS.mark.is(el)) return 'mark';
    if (KINDS.size.is(el)) return 'size';
    return null;
  }

  /** node 위쪽(bound 전까지)에서 이 갈래의 래퍼를 찾는다 */
  function wrapperAbove(node, kind, bound) {
    const stop = bound || editorEl;
    let n = node;
    while (n && n !== stop) {
      if (n.nodeType === Node.ELEMENT_NODE && KINDS[kind].is(n)) return n;
      n = n.parentNode;
    }
    return null;
  }

  /** parent를 [앞] [child] [뒤] 세 조각으로 가른다(빈 조각은 만들지 않는다) */
  function splitAround(parent, child) {
    const owner = parent.parentNode;
    if (!owner) return;
    if (parent.firstChild !== child) {
      const before = parent.cloneNode(false);
      while (parent.firstChild && parent.firstChild !== child) before.appendChild(parent.firstChild);
      owner.insertBefore(before, parent);
    }
    if (child.nextSibling) {
      const after = parent.cloneNode(false);
      while (child.nextSibling) after.appendChild(child.nextSibling);
      owner.insertBefore(after, parent.nextSibling);
    }
  }

  /**
   * node를 감싸고 있는 wrapper에서 node만 쏙 빼낸다.
   * 래퍼를 경계에서 갈라 두므로 범위 바깥 글자는 서식을 그대로 지킨다 —
   * "고른 부분만 바뀐다"의 핵심이자, 같은 서식이 두 겹 쌓이지 않게 하는 길.
   */
  function liftOutOf(node, wrapper) {
    let cur = node;
    while (cur.parentNode && cur.parentNode !== wrapper && cur.parentNode !== editorEl) {
      splitAround(cur.parentNode, cur);
      cur = cur.parentNode;
    }
    if (cur.parentNode !== wrapper) return; // 어긋났다면 차라리 손대지 않는다
    splitAround(wrapper, cur);
    unwrapEl(wrapper);
  }

  /** 고른 범위 안에서만 이 갈래의 서식을 걷어 낸다 */
  function clearKindWithin(targets, kind) {
    for (const t of targets) {
      let w, guard = 0;
      while ((w = wrapperAbove(t, kind)) && guard++ < 20) liftOutOf(t, w);
    }
  }

  /** 이웃한 글자 노드를 한 덩이로 묶어 래퍼 하나씩 씌운다(블록 경계를 넘지 않는다) */
  function wrapRuns(targets, make) {
    let i = 0;
    while (i < targets.length) {
      const run = [targets[i]];
      let j = i + 1;
      while (j < targets.length) {
        const last = run[run.length - 1];
        if (targets[j].parentNode !== last.parentNode || targets[j].previousSibling !== last) break;
        run.push(targets[j]);
        j++;
      }
      const holder = run[0].parentNode;
      if (holder) {
        const w = make();
        holder.insertBefore(w, run[0]);
        run.forEach(n => w.appendChild(n));
      }
      i = j;
    }
  }

  /** 마무리 정돈 — 겹친 래퍼 풀기, 이웃한 같은 래퍼 합치기, 빈 것 버리기 */
  function normalizeInline(scope) {
    const nested = (el, kind) => {
      let n = el.parentNode;
      while (n && n !== scope) {
        if (n.nodeType === Node.ELEMENT_NODE && KINDS[kind].is(n)) return true;
        n = n.parentNode;
      }
      return false;
    };

    // 같은 서식이 겹겹이 쌓였으면 안쪽을 벗긴다(바깥이 이미 그 서식을 준다)
    [...scope.querySelectorAll(KIND_SELECTOR)].forEach(el => {
      if (!el.isConnected) return;
      const kind = kindOf(el);
      if (kind && nested(el, kind)) unwrapEl(el);
    });

    // 나란히 붙은 같은 래퍼는 하나로 합친다
    [...scope.querySelectorAll(KIND_SELECTOR)].forEach(el => {
      if (!el.isConnected) return;
      const kind = kindOf(el);
      if (!kind) return;
      let next = el.nextSibling;
      while (next && next.nodeType === Node.ELEMENT_NODE &&
             KINDS[kind].is(next) && KINDS[kind].same(el, next)) {
        while (next.firstChild) el.appendChild(next.firstChild);
        const gone = next;
        next = next.nextSibling;
        gone.remove();
      }
    });

    // 빈 래퍼와 구실 없는 span은 버린다
    [...scope.querySelectorAll(KIND_SELECTOR)].forEach(el => {
      if (!el.isConnected) return;
      if (!el.firstChild) { el.remove(); return; }
      if (el.tagName === 'SPAN' && !KINDS.size.is(el)) unwrapEl(el);
    });
  }

  /**
   * 형광펜·글자 크기를 고른 부분에만, 딱 한 겹으로 입힌다.
   * value가 비면 그 서식을 걷어 낸다.
   */
  function applyInline(kind, value, emptyMsg) {
    editorEl.focus();
    const sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed ||
        !editorEl.contains(sel.getRangeAt(0).commonAncestorContainer)) {
      UI.toast(emptyMsg);
      return;
    }
    const range = sel.getRangeAt(0);
    splitBoundaries(range);
    const targets = textNodesIn(range).filter(n => editorEl.contains(n));
    if (!targets.length) { UI.toast(emptyMsg); return; }

    clearKindWithin(targets, kind);   // 이 한 줄이 '이중 적용'을 원천 차단한다
    if (value) wrapRuns(targets, () => KINDS[kind].make(value));
    normalizeInline(editorEl);

    // 고른 자리를 그대로 두어 서식을 연달아 줄 수 있게 한다
    const alive = targets.filter(n => editorEl.contains(n));
    if (alive.length) {
      const last = alive[alive.length - 1];
      const r = document.createRange();
      r.setStart(alive[0], 0);
      r.setEnd(last, last.length);
      sel.removeAllRanges();
      sel.addRange(r);
      savedRange = r.cloneRange();
    }
    handleChange();
    updateToolbarState();
  }

  /** 고른 곳이 통째로 형광펜인가 */
  function allMarked(targets) {
    return targets.length > 0 && targets.every(t => !!wrapperAbove(t, 'mark'));
  }

  function toggleMark() {
    editorEl.focus();
    const msg = '형광펜을 칠할 부분을 먼저 골라 주세요.';
    const sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed ||
        !editorEl.contains(sel.getRangeAt(0).commonAncestorContainer)) {
      UI.toast(msg);
      return;
    }
    // 통째로 칠해져 있을 때만 지운다. 일부만 겹쳤다면 나머지까지 마저 칠한다
    // — Word·한글과 같은 셈이고, 덧칠해 두 겹이 되는 일이 없다.
    const on = allMarked(textNodesIn(sel.getRangeAt(0)));
    applyInline('mark', on ? '' : 'on', msg);
  }

  /** 이 글 전체의 줄 간격을 바꾼다 */
  function setLineHeight(v) {
    if (!LINE_HEIGHTS.includes(v)) v = 'normal';
    lineHeight = v;
    if (editorEl) {
      LH_CLASSES.forEach(c => editorEl.classList.remove(c));
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

  const LH_BLOCK_TAGS = 'p,h2,h3,li,blockquote,pre';

  /** 범위가 이 블록을 통째로 삼켰는가(글자가 없는 빈 문단도 세기 위함) */
  function fullyInside(node, range) {
    let r;
    try {
      r = document.createRange();
      r.selectNode(node);
    } catch (e) { return false; }
    return range.compareBoundaryPoints(Range.START_TO_START, r) <= 0 &&
           range.compareBoundaryPoints(Range.END_TO_END, r) >= 0;
  }

  /** node가 놓인 문단(블록) */
  function blockOf(node) {
    if (!node) return null;
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!el || !editorEl.contains(el)) return null;
    const b = el.closest(LH_BLOCK_TAGS);
    return b && editorEl.contains(b) ? b : null;
  }

  /** 고른 문단(또는 커서가 있는 문단)의 줄 간격만 바꾼다 */
  function applyBlockLineHeight(v) {
    editorEl.focus();
    restoreSelection();
    const sel = window.getSelection();
    if (!sel.rangeCount || !editorEl.contains(sel.getRangeAt(0).commonAncestorContainer)) {
      UI.toast('간격을 바꿀 문단에 커서를 두거나, 여러 문단을 골라 주세요.');
      return;
    }
    const range = sel.getRangeAt(0);
    const collapsed = range.collapsed;
    const caretNode = range.startContainer;

    // 정규화가 노드를 옮기면 Range 기준점이 밀려나므로,
    // 옮기기 전에 선택이 걸친 것들을 먼저 기억해 둔다.
    // 문단은 '그 안의 글자가 실제로 뽑혔는가'로 가린다. 선택이 다음 문단
    // 첫머리에서 끝났다면 그 문단의 글자는 하나도 안 뽑히므로 딸려 오지 않는다.
    const touched = collapsed ? [] : textNodesIn(range);
    // 글자가 없는 빈 문단도 통째로 삼켜졌다면 함께 센다
    const swallowed = collapsed ? []
      : [...editorEl.querySelectorAll(LH_BLOCK_TAGS)].filter(b => fullyInside(b, range));

    normalizeBlocks();

    const blockSet = new Set();
    for (const n of touched) {
      const block = blockOf(n);
      if (block) blockSet.add(block);
    }
    for (const b of swallowed) {
      if (editorEl.contains(b)) blockSet.add(b);
    }
    // 커서만 놓았다면 그 자리의 문단 하나 (정규화로 갓 생긴 <p>일 수도 있다)
    if (collapsed) {
      const block = blockOf(caretNode);
      if (block) blockSet.add(block);
    }

    if (!blockSet.size) {
      UI.toast('간격을 바꿀 문단을 찾지 못했습니다.');
      return;
    }
    blockSet.forEach(b => {
      LH_CLASSES.forEach(c => b.classList.remove(c));
      // '보통'도 클래스로 못 박는다 — 그러지 않으면 글 전체 설정을 도로 물려받아
      // 문단마다 간격이 제멋대로로 보인다.
      if (LINE_HEIGHTS.includes(v)) b.classList.add('lh-' + v);
      if (!b.classList.length) b.removeAttribute('class');
    });
    handleChange();
    updateToolbarState();
  }

  /** 고른 부분의 글자 크기를 바꾼다(cls가 비면 보통으로 되돌린다) */
  function applySize(cls) {
    editorEl.focus();
    restoreSelection();
    applyInline('size', cls, '크기를 바꿀 부분을 먼저 골라 주세요.');
  }

  /* ---------- 지금 무엇이 적용되어 있는가 (도구막대 표시) ---------- */
  const SIZE_NAMES = { '': '보통', 't-sm': '작게', 't-lg': '크게', 't-xl': '아주 크게' };
  const LH_NAMES = { tight: '좁게', normal: '보통', loose: '넓게' };
  const MIXED = '섞임';

  function sizeAt(node) {
    const w = wrapperAbove(node, 'size');
    return w ? (SIZE_CLASSES.find(c => w.classList.contains(c)) || '') : '';
  }

  /** 고른 글자들의 크기가 모두 같으면 그 값, 섞였으면 MIXED */
  function currentSize() {
    const sel = window.getSelection();
    if (!sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (!editorEl.contains(range.commonAncestorContainer)) return null;
    if (range.collapsed) return sizeAt(range.startContainer);
    const targets = textNodesIn(range);
    if (!targets.length) return sizeAt(range.startContainer);
    const first = sizeAt(targets[0]);
    return targets.every(t => sizeAt(t) === first) ? first : MIXED;
  }

  /**
   * 고른 문단들의 줄 간격.
   * 문단에 못 박힌 값이 없으면 글 전체 설정을 따르므로 그 값을 돌려준다
   * (도구막대에는 '지금 눈에 보이는 간격'이 떠야 한다).
   */
  function currentBlockLh() {
    const sel = window.getSelection();
    if (!sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (!editorEl.contains(range.commonAncestorContainer)) return null;
    let blocks;
    if (range.collapsed) {
      blocks = [blockOf(range.startContainer)].filter(Boolean);
    } else {
      const set = new Set();
      textNodesIn(range).forEach(t => { const b = blockOf(t); if (b) set.add(b); });
      [...editorEl.querySelectorAll(LH_BLOCK_TAGS)]
        .forEach(b => { if (fullyInside(b, range)) set.add(b); });
      blocks = [...set];
    }
    if (!blocks.length) return null;
    const at = (b) => LINE_HEIGHTS.find(v => b.classList.contains('lh-' + v)) || lineHeight;
    const first = at(blocks[0]);
    if (!blocks.every(b => at(b) === first)) return { mixed: true };
    return { v: first, pinned: !!LINE_HEIGHTS.find(v => blocks[0].classList.contains('lh-' + v)) };
  }

  /** 팝오버에 지금 값을 체크로 표시한다 */
  function refreshPopMarks(size, lh) {
    if (!popEl) return;
    popEl.querySelectorAll('[data-size]').forEach(b => {
      b.classList.toggle('on', size != null && size !== MIXED && b.dataset.size === size);
    });
    popEl.querySelectorAll('[data-lhsel]').forEach(b => {
      b.classList.toggle('on', !!lh && !lh.mixed && b.dataset.lhsel === lh.v);
    });
    popEl.querySelectorAll('[data-lhdoc]').forEach(b => {
      b.classList.toggle('on', b.dataset.lhdoc === lineHeight);
    });
  }

  /** 켜져 있는 서식을 도구막대에 비춘다 — Word·한글처럼 */
  function updateToolbarState() {
    if (!root || !editorEl || !editorEl.isConnected) return;
    const sel = window.getSelection();
    const range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
    const inside = !!range && editorEl.contains(range.commonAncestorContainer);

    const state = {};
    if (inside) {
      const q = (c) => { try { return document.queryCommandState(c); } catch (e) { return false; } };
      state.bold = q('bold');
      state.italic = q('italic');
      state.underline = q('underline');
      state.strike = q('strikeThrough');
      state.ul = q('insertUnorderedList');
      state.ol = q('insertOrderedList');
      const block = currentBlockTag();
      state.h2 = block === 'H2';
      state.h3 = block === 'H3';
      state.quote = block === 'BLOCKQUOTE';
      state.code = block === 'PRE';
      state.mark = range.collapsed
        ? !!wrapperAbove(range.startContainer, 'mark')
        : allMarked(textNodesIn(range));
    }

    root.querySelectorAll('.tool[data-cmd]').forEach(btn => {
      if (!(btn.dataset.cmd in state) && !TOGGLEABLE.has(btn.dataset.cmd)) return;
      const on = !!state[btn.dataset.cmd];
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });

    // 크기·줄간격은 켜짐/꺼짐이 아니라 '지금 값'을 이름 옆에 보여 준다
    const size = inside ? currentSize() : null;
    const lh = inside ? currentBlockLh() : null;
    const show = (menu, base, text) => {
      const btn = root.querySelector(`.tool[data-menu="${menu}"]`);
      if (!btn) return;
      const slot = btn.querySelector('.menu-now');
      if (slot) slot.textContent = text ? ' · ' + text : '';
      btn.title = base + (text ? ' — 지금 ' + text : '');
    };
    show('size', '글자 크기 — 고른 부분에 적용',
      size === MIXED ? MIXED : (size == null ? '' : SIZE_NAMES[size]));
    show('lh', '줄 간격 — 고른 문단 또는 글 전체',
      !lh ? '' : (lh.mixed ? MIXED : LH_NAMES[lh.v]));

    if (popEl) refreshPopMarks(size, lh);
  }

  // 켜짐/꺼짐을 표시하는 도구들
  const TOGGLEABLE = new Set(['bold', 'italic', 'underline', 'strike', 'mark',
    'h2', 'h3', 'quote', 'ul', 'ol', 'code']);

  let stateRaf = 0;
  function queueToolbarState() {
    if (stateRaf) return;
    stateRaf = requestAnimationFrame(() => { stateRaf = 0; updateToolbarState(); });
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

  /** 이 글의 이름표를 확정한다 — 붙임은 담기 전에도 이 이름 아래 보관되어야 한다 */
  function ensureNoteId() {
    if (!noteId) noteId = note ? note.id : UI.uuid();
    return noteId;
  }

  let askedPersist = false;
  function requestPersistence() {
    if (askedPersist || !navigator.storage || !navigator.storage.persist) return;
    askedPersist = true;
    // 파일까지 담기 시작하면 저장 공간이 밀려날 위험이 커진다 — 오래 두어 달라고 청한다
    navigator.storage.persist().catch(() => { /* 거절해도 그만 */ });
  }

  /** 그림이 아닌 파일을 붙임으로 보관한다 */
  async function attachFiles(list) {
    const files = [...list];
    if (!files.length) return;
    const gen = mountGen;
    const owner = ensureNoteId();
    let total = attachments.reduce((s, f) => s + (f.size || 0), 0);

    for (const file of files) {
      if (attachments.length >= FILES_COUNT_MAX) {
        UI.toast(`붙임은 한 글에 ${FILES_COUNT_MAX}개까지 담을 수 있습니다.`);
        break;
      }
      if (file.size > FILE_MAX) {
        UI.toast(`'${file.name}' — 파일 하나는 ${fmtSize(FILE_MAX)}까지 담을 수 있습니다.`);
        continue;
      }
      if (total + file.size > FILES_TOTAL_MAX) {
        UI.toast(`한 글의 붙임은 모두 합쳐 ${fmtSize(FILES_TOTAL_MAX)}까지입니다.`);
        break;
      }
      const meta = {
        id: UI.uuid(),
        name: safeFileName(file.name),
        type: file.type || '',
        size: file.size,
        addedAt: Date.now(),
      };
      try {
        await DB.putFile({ ...meta, noteId: owner, blob: file });
      } catch (e) {
        UI.toast('파일을 담지 못했습니다. 저장 공간이 부족할 수 있습니다 — 서랍에서 내보내기로 갈무리해 주세요.');
        break;
      }
      if (gen !== mountGen) return; // 그 사이 화면이 바뀌었다
      total += meta.size;
      attachments.push(meta);
    }
    if (gen !== mountGen) return;
    renderFiles();
    handleChange();
    requestPersistence();
  }

  async function removeAttachment(id) {
    const target = attachments.find(f => f.id === id);
    if (!target) return;
    const ok = await UI.confirmModal({
      title: '붙임 지우기',
      body: `「${esc(target.name)}」을 이 글에서 지웁니다.`,
      okText: '지우기',
    });
    if (!ok || !root) return;
    const i = attachments.findIndex(f => f.id === id);
    if (i < 0) return;
    attachments.splice(i, 1);
    DB.delFile(id).catch(() => { /* 지우기 실패는 청소가 마저 맡는다 */ });
    renderFiles();
    handleChange();
  }

  function renderFiles() {
    if (!filesEl) return;
    const total = attachments.reduce((s, f) => s + (f.size || 0), 0);
    const head = `
      <div class="files-head">
        <span class="files-title">붙임${attachments.length
          ? ` <small>${attachments.length}개 · ${fmtSize(total)}</small>` : ''}</span>
        <button type="button" class="btn files-add">파일 고르기</button>
      </div>`;
    filesEl.innerHTML = head + (attachments.length ? `
      <ul class="file-list">
        ${attachments.map(f => `
          <li class="file-row">
            <span class="file-name" title="${esc(f.name)}">${esc(f.name)}</span>
            <span class="file-size">${fmtSize(f.size)}</span>
            <button type="button" class="file-get" data-id="${esc(f.id)}"
                    aria-label="${esc(f.name)} 내려받기">내려받기</button>
            <button type="button" class="file-del" data-id="${esc(f.id)}"
                    aria-label="${esc(f.name)} 지우기">×</button>
          </li>`).join('')}
      </ul>` : `
      <p class="files-empty">글과 함께 보관할 파일을 붙여 둘 수 있습니다. 여기로 끌어다 놓아도 됩니다.</p>`);

    filesEl.querySelector('.files-add').addEventListener('click', () => fileAnyEl.click());
    filesEl.querySelectorAll('.file-get').forEach(b =>
      b.addEventListener('click', () => downloadFile(b.dataset.id)));
    filesEl.querySelectorAll('.file-del').forEach(b =>
      b.addEventListener('click', () => removeAttachment(b.dataset.id)));
  }

  /** 끌어다 놓거나 붙여넣은 것들 — 그림은 본문에, 나머지는 붙임으로 */
  async function insertFiles(files) {
    const gen = mountGen;
    const all = [...files];
    const images = all.filter(f => f.type && f.type.startsWith('image/'));
    const others = all.filter(f => !(f.type && f.type.startsWith('image/')));
    if (others.length) attachFiles(others);
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
      case 'file': fileAnyEl.click(); break;
    }
    if (cmd !== 'link' && cmd !== 'image' && cmd !== 'file') handleChange();
    queueToolbarState();
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

  /** 되살릴 가치가 있는 임시저장인가(제목·본문 글자·사진·태그·붙임 중 하나라도) */
  function draftMeaningful(d) {
    if (!d) return false;
    if (d.title && d.title.trim()) return true;
    if (Array.isArray(d.tags) && d.tags.length) return true;
    if (Array.isArray(d.files) && d.files.length) return true;
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
        // 이름표를 알맹이 안에 실어 둔다. 붙임 파일이 이 이름표로 저장소에 담겨 있으므로,
        // 나중에 「이어서 쓰기」로 되살릴 때 그 파일들의 주인을 되찾을 수 있다.
        id: noteId,
        title: titleEl.value,
        html: editorEl.innerHTML,
        tags,
        lineHeight,
        files: attachments,
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
      // 붙임 파일은 이름표로 저장소에 담겨 있다 — 그 이름표를 이어받아 주인을 되찾는다
      if (!note && typeof draft.id === 'string' && draft.id) {
        const abandoned = noteId;
        noteId = draft.id;
        if (abandoned && abandoned !== noteId) DB.delFilesOf(abandoned).catch(() => {});
        attachments = Array.isArray(draft.files) ? draft.files.filter(f => f && f.id) : [];
      }
      renderChips();
      renderFiles();
      updateCount();
      pendingOldDraft = null;
      if (key !== draftKey) removeKey(key); // 갈피에서 되살렸으면 갈피는 비운다
      slot.innerHTML = '';
      scheduleDraft();
    });
    slot.querySelector('.draft-discard').addEventListener('click', () => {
      removeKey(key);
      // 되살리지 않기로 했으니 그 글이 붙들고 있던 파일도 놓아 준다
      if (draft.id && draft.id !== noteId) DB.delFilesOf(draft.id).catch(() => {});
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
    queueToolbarState();
  }

  /* ---------- 고친 게 있는가 · 떠나기 ---------- */

  /** 지금 내용을 견줄 수 있는 꼴로 (담긴 것과 달라졌는지 가리기 위함) */
  function snapshot() {
    if (!editorEl || !titleEl) return null;
    return JSON.stringify([
      titleEl.value.trim(),
      sanitize(editorEl.innerHTML),
      tags,
      lineHeight,
      attachments.map(f => f.id),
    ]);
  }

  /**
   * 담아 둔 것과 달라졌는가.
   * draftPending은 '예약된 임시저장이 있는가'일 뿐이라 잣대가 되지 못한다.
   */
  function isDirty() {
    return !!root && baseline !== null && snapshot() !== baseline;
  }

  function goBack() {
    // 앱 안에서 돌아다닌 이력이 있을 때만 뒤로 간다(밖에서 바로 들어왔으면 홈으로)
    let canBack = false;
    try { canBack = typeof App !== 'undefined' && App.canGoBack(); } catch (e) { /* 무시 */ }
    if (canBack) history.back();
    else location.hash = '#/';
  }

  /** 고친 게 있으면 세 갈래를 물은 뒤 떠난다 */
  async function leave(go) {
    if (!isDirty()) { leaving = true; go(); return; }
    const pick = await UI.choiceModal({
      title: '여백을 떠나시겠습니까',
      body: '아직 담지 않은 내용이 있습니다.<br>' +
            '<small>그냥 나가더라도 쓰던 글은 임시저장되어 다음에 이어 쓸 수 있습니다.</small>',
      choices: [
        { key: 'stay', label: '계속 쓰기', autofocus: true },
        { key: 'discard', label: '그냥 나가기' },
        { key: 'save', label: '담고 나가기', primary: true },
      ],
    });
    if (!pick || pick === 'stay') return;
    if (pick === 'save') { save(); return; } // 담기면 알아서 그 글 화면으로 옮겨 간다
    leaving = true;
    go();
  }

  /**
   * 편집기에서 벗어나려 할 때 App이 부른다.
   * 붙잡았으면(=물어봐야 하면) 주소를 편집기 자리로 되돌려 놓고 true를 돌려준다.
   * hashchange는 막을 수 없으므로 '되돌린 뒤 묻는' 길을 쓴다.
   */
  function guardLeave() {
    if (!root || leaving || !isDirty()) return false;
    const target = location.hash || '#/';
    if (target === editorHash) return false;
    location.hash = editorHash;   // 편집기 자리로 되돌린다
    // 되돌리며 생기는 hashchange가 대화상자를 도로 닫아 버리므로
    // (앱은 화면이 바뀌면 떠 있던 대화상자를 접는다) 한 박자 늦춰 묻는다
    setTimeout(() => { if (root) leave(() => { location.hash = target; }); }, 0);
    return true;
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
        id: ensureNoteId(),
        title,
        html,
        text,
        tags: [...tags],
        lineHeight,
        files: attachments.map(f => ({ ...f })),
        createdAt: note ? note.createdAt : now,
        updatedAt: now,
      };

      await DB.put(saved); // 트랜잭션 커밋까지 확인된 뒤에야 성공이다
      note = saved;        // 연이어 저장해도 같은 글로 갱신되게
      clearTimeout(draftTimer);
      draftPending = false; // 방금 담은 글이 임시저장으로 되살아나지 않게
      draftClear();
      baseline = snapshot(); // 이제 담긴 것과 같아졌다 — 확인창 없이 떠날 수 있다
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
    // 미리보기 글자 크기는 실제로 입혀지는 값(css의 .t-*)과 같아야 메뉴가 거짓말을 하지 않는다
    const items = [
      ['t-sm', '작게', '0.85em'],
      ['', '보통', '1em'],
      ['t-lg', '크게', '1.25em'],
      ['t-xl', '아주 크게', '1.5em'],
    ];
    return items.map(([v, label, size]) =>
      `<button type="button" class="pop-item" role="menuitem" data-size="${v}"><span style="font-size:${size}">${label}</span></button>`
    ).join('');
  }

  function buildLhPop() {
    const row = (attr) => LINE_HEIGHTS.map(v =>
      `<button type="button" class="pop-item" role="menuitem" data-${attr}="${v}">${LH_NAMES[v]}</button>`
    ).join('');
    return `
      <div class="pop-label">고른 문단만</div>
      <div class="pop-row">${row('lhsel')}</div>
      <div class="pop-label">글 전체</div>
      <div class="pop-row">${row('lhdoc')}</div>`;
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
    refreshPopMarks(currentSize(), currentBlockLh()); // 지금 값에 체크를 놓는다

    // 항목을 눌러도 편집기의 선택이 풀리지 않게
    popEl.querySelectorAll('button').forEach(b => b.addEventListener('mousedown', e => e.preventDefault()));
    popEl.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.size !== undefined) applySize(b.dataset.size);
      else if (b.dataset.lhsel) applyBlockLineHeight(b.dataset.lhsel);
      else if (b.dataset.lhdoc) { setLineHeight(b.dataset.lhdoc); scheduleDraft(); queueToolbarState(); }
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

    // 커서가 움직일 때마다 '지금 무엇이 켜져 있는지'를 도구막대에 비춘다
    selectionHandler = () => {
      if (composing || !root || !editorEl || !editorEl.isConnected) return;
      queueToolbarState();
    };
    document.addEventListener('selectionchange', selectionHandler);
    ['keyup', 'mouseup', 'focus'].forEach(ev =>
      editorEl.addEventListener(ev, () => { if (!composing) queueToolbarState(); }));
    editorEl.addEventListener('compositionstart', () => { composing = true; });
    editorEl.addEventListener('compositionend', () => { composing = false; queueToolbarState(); });

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
        const files = [...items].filter(i => i.kind === 'file').map(i => i.getAsFile()).filter(Boolean);
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

    // 「파일 고르기」·클립 단추로 고른 것은 그림이라도 본문이 아니라 붙임으로 간다
    fileAnyEl.addEventListener('change', () => {
      if (fileAnyEl.files.length) attachFiles(fileAnyEl.files);
      fileAnyEl.value = '';
    });

    // 붙임 구획에 바로 끌어다 놓기
    filesEl.addEventListener('dragover', e => {
      if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) {
        e.preventDefault();
        filesEl.classList.add('dragover');
      }
    });
    filesEl.addEventListener('dragleave', () => filesEl.classList.remove('dragover'));
    filesEl.addEventListener('drop', e => {
      filesEl.classList.remove('dragover');
      if (e.dataTransfer && e.dataTransfer.files.length) {
        e.preventDefault();
        attachFiles(e.dataTransfer.files);
      }
    });

    saveBtnEl.addEventListener('click', save);
    $('.cancel-btn').addEventListener('click', () => { leave(goBack); });

    // 머리말 차림표로 빠져나가는 길도 같은 확인창을 지나게 한다
    navGuard = (e) => {
      if (leaving || !root) return;
      const a = e.target.closest && e.target.closest('a[href^="#"]');
      const head = document.querySelector('.site-head');
      if (!a || !head || !head.contains(a)) return;
      if (a.getAttribute('href') === editorHash || !isDirty()) return;
      e.preventDefault();
      e.stopPropagation();
      leave(() => { location.hash = a.getAttribute('href'); });
    };
    document.addEventListener('click', navGuard, true);

    keydownHandler = (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.repeat && e.key.toLowerCase() === 's') {
        e.preventDefault();
        save();
      }
    };
    document.addEventListener('keydown', keydownHandler);

    // 창을 닫거나 새로 고칠 때, 기다리던 임시저장을 마저 해 두고
    // 아직 담지 않은 내용이 있으면 브라우저가 한 번 더 묻게 한다
    beforeUnloadHandler = (e) => {
      if (draftPending) {
        clearTimeout(draftTimer);
        draftSave();
      }
      if (isDirty()) {
        e.preventDefault();
        e.returnValue = '';
        return '';
      }
    };
    window.addEventListener('beforeunload', beforeUnloadHandler);
  }

  return {
    mount, unmount, sanitize, htmlToText, isDirty, guardLeave,
    downloadFile, fmtSize, safeFileName,   // 열람 화면과 서랍에서도 쓴다
  };
})();
