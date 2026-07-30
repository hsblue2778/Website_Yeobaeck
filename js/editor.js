/* 여백 — 글쓰기 (서식 · 사진 · 임시저장 · HTML 정돈) */
const Editor = (() => {
  'use strict';

  /* ---------- HTML 정돈(sanitize) ---------- */
  // 허용 태그와 태그별 허용 속성. 그 밖의 태그는 내용만 남기고 벗겨 낸다.
  const ALLOWED = {
    P: [], H2: [], H3: [], BR: [], HR: [],
    B: [], STRONG: [], I: [], EM: [], U: [], S: [], STRIKE: [], DEL: [],
    MARK: [], SUP: [], SUB: [],
    BLOCKQUOTE: [], UL: [], OL: [], LI: [],
    PRE: [], CODE: [],
    A: ['href'], IMG: ['src', 'alt'],
    FIGURE: [], FIGCAPTION: [],
    TABLE: [], THEAD: [], TBODY: [], TFOOT: [], TR: [], TH: [], TD: [],
    DIV: [],
  };
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
          }
        }

        // src 없는 이미지는 버린다
        if (tag === 'IMG' && !child.getAttribute('src')) child.remove();
      }
    })(rootEl);

    return rootEl.innerHTML;
  }

  function htmlToText(html) {
    const doc = new DOMParser().parseFromString('<div>' + (html || '') + '</div>', 'text/html');
    doc.querySelectorAll('script,style').forEach(el => el.remove());
    // 블록 요소 사이에 공백을 넣어 단어가 붙지 않게 한다
    doc.querySelectorAll('p,div,h2,h3,li,blockquote,pre,br,tr,figcaption').forEach(el => {
      el.insertAdjacentText('afterend', ' ');
    });
    return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
  }

  /* ---------- 사진 처리 ---------- */
  const MAX_EDGE = 1600;      // 긴 변 기준 픽셀
  const JPEG_QUALITY = 0.85;
  const KEEP_ORIGINAL_UNDER = 400 * 1024; // 이 크기보다 작은 png/gif는 원본 유지

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

  async function compressImage(file) {
    const original = await readAsDataURL(file);
    // 움직이는 그림이나 작은 파일은 그대로 둔다
    if (file.type === 'image/gif') return original;
    if (file.type === 'image/png' && file.size <= KEEP_ORIGINAL_UNDER) return original;

    try {
      const img = await loadImage(original);
      let { naturalWidth: w, naturalHeight: h } = img;
      if (!w || !h) return original;

      const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
      const cw = Math.max(1, Math.round(w * scale));
      const ch = Math.max(1, Math.round(h * scale));

      if (scale === 1 && file.size <= KEEP_ORIGINAL_UNDER) return original;

      const canvas = document.createElement('canvas');
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext('2d');
      // 투명 배경이 검게 변하지 않도록 종이색을 깔아 준다
      ctx.fillStyle = '#f7f4ee';
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
  let countEl = null, draftStatusEl = null, fileInputEl = null;
  let note = null;        // 수정 대상(새 글이면 null)
  let tags = [];
  let onSaveCb = null;
  let draftKey = 'yeobaeck.draft.new';
  let draftTimer = null;
  let keydownHandler = null;
  let savedRange = null;  // 모달이 초점을 가져갈 때 선택 영역 보관

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
    root = container;
    note = existingNote || null;
    tags = note ? [...(note.tags || [])] : [];
    onSaveCb = opts && opts.onSave;
    draftKey = 'yeobaeck.draft.' + (note ? note.id : 'new');

    const toolsHtml = TOOLS.map(t =>
      t.sep
        ? '<span class="sep"></span>'
        : `<button type="button" class="tool" data-cmd="${t.cmd}" title="${esc(t.title)}" aria-label="${esc(t.title)}">${t.label}</button>`
    ).join('');

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

    if (note) editorEl.innerHTML = sanitize(note.html);

    try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch (e) { /* 무시 */ }

    renderChips();
    updateCount();
    bindEvents();
    maybeOfferDraft();

    if (!note) titleEl.focus();
  }

  function unmount() {
    if (keydownHandler) {
      document.removeEventListener('keydown', keydownHandler);
      keydownHandler = null;
    }
    clearTimeout(draftTimer);
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

  function askLink() {
    saveSelection();
    UI.promptModal({
      title: '링크 걸기',
      placeholder: 'https://…',
      okText: '걸기',
    }).then(url => {
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
    const images = [...files].filter(f => f.type && f.type.startsWith('image/'));
    if (!images.length) return;
    UI.toast(images.length > 1 ? `사진 ${images.length}장을 담는 중…` : '사진을 담는 중…');
    for (const file of images) {
      try {
        const dataUrl = await compressImage(file);
        editorEl.focus();
        restoreSelection();
        exec('insertHTML', `<figure><img src="${dataUrl}" alt="${esc(file.name.replace(/\.[^.]+$/, ''))}"></figure><p><br></p>`);
        saveSelection();
      } catch (e) {
        UI.toast('사진을 넣지 못했습니다.');
      }
    }
    handleChange();
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
  function draftLoad() {
    try {
      const raw = localStorage.getItem(draftKey);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function draftSave() {
    try {
      localStorage.setItem(draftKey, JSON.stringify({
        title: titleEl.value,
        html: editorEl.innerHTML,
        tags,
        at: Date.now(),
      }));
      draftStatusEl.textContent = '임시저장 ' + new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
    } catch (e) {
      // 사진이 커서 localStorage 한도를 넘으면 조용히 넘어간다(정식 저장은 IndexedDB)
      draftStatusEl.textContent = '';
    }
  }

  function draftClear() {
    try { localStorage.removeItem(draftKey); } catch (e) { /* 무시 */ }
  }

  function scheduleDraft() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(draftSave, 900);
  }

  function maybeOfferDraft() {
    const draft = draftLoad();
    if (!draft) return;
    if (note && !(draft.at > note.updatedAt)) { draftClear(); return; }
    if (!note && !draft.title && !htmlToText(draft.html)) { draftClear(); return; }

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
      renderChips();
      updateCount();
      slot.innerHTML = '';
    });
    slot.querySelector('.draft-discard').addEventListener('click', () => {
      draftClear();
      slot.innerHTML = '';
    });
  }

  /* ---------- 저장 ---------- */
  function updateCount() {
    const n = htmlToText(editorEl.innerHTML).length;
    countEl.textContent = n.toLocaleString('ko-KR') + '자';
  }

  function handleChange() {
    updateCount();
    scheduleDraft();
  }

  async function save() {
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

    const html = sanitize(editorEl.innerHTML);
    const text = htmlToText(html);
    const now = Date.now();
    const saved = {
      id: note ? note.id : UI.uuid(),
      title,
      html,
      text,
      tags: [...tags],
      createdAt: note ? note.createdAt : now,
      updatedAt: now,
    };

    try {
      await DB.put(saved);
    } catch (e) {
      UI.toast('저장하지 못했습니다. 저장 공간을 확인해 주세요.');
      return;
    }
    draftClear();
    if (onSaveCb) onSaveCb(saved);
  }

  /* ---------- 사건 연결 ---------- */
  function bindEvents() {
    root.querySelectorAll('.tool').forEach(btn => {
      // mousedown에서 초점을 잃지 않게 막는다
      btn.addEventListener('mousedown', e => e.preventDefault());
      btn.addEventListener('click', () => runTool(btn.dataset.cmd));
    });

    editorEl.addEventListener('input', handleChange);
    titleEl.addEventListener('input', scheduleDraft);

    tagInputEl.addEventListener('keydown', e => {
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

    // 끌어다 놓기
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
        saveSelection();
        insertFiles(e.dataTransfer.files);
      }
    });

    fileInputEl.addEventListener('change', () => {
      if (fileInputEl.files.length) insertFiles(fileInputEl.files);
      fileInputEl.value = '';
    });

    $('.save-btn').addEventListener('click', save);
    $('.cancel-btn').addEventListener('click', () => {
      history.length > 1 ? history.back() : (location.hash = '#/');
    });

    keydownHandler = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        save();
      }
    };
    document.addEventListener('keydown', keydownHandler);
  }

  return { mount, unmount, sanitize, htmlToText };
})();
