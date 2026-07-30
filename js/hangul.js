/* 여백 — 한글 유틸리티 (초성 검색 · 색인 분류) */
const HANGUL = (() => {
  'use strict';

  const CHO = ['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
  // 사전 색인에서는 쌍자음을 홑자음 항목에 함께 싣는다
  const CHO_BASE = { 'ㄲ':'ㄱ', 'ㄸ':'ㄷ', 'ㅃ':'ㅂ', 'ㅆ':'ㅅ', 'ㅉ':'ㅈ' };
  // 겹받침 호환 자모로 시작하는 제목도 첫 자음 항목에 싣는다
  const JAMO_BASE = {
    'ㄳ':'ㄱ', 'ㄵ':'ㄴ', 'ㄶ':'ㄴ', 'ㄺ':'ㄹ', 'ㄻ':'ㄹ', 'ㄼ':'ㄹ',
    'ㄽ':'ㄹ', 'ㄾ':'ㄹ', 'ㄿ':'ㄹ', 'ㅀ':'ㄹ', 'ㅄ':'ㅂ',
  };
  const INDEX_ORDER = [
    'ㄱ','ㄴ','ㄷ','ㄹ','ㅁ','ㅂ','ㅅ','ㅇ','ㅈ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ',
    'A','B','C','D','E','F','G','H','I','J','K','L','M',
    'N','O','P','Q','R','S','T','U','V','W','X','Y','Z','#'
  ];

  const SYL_START = 0xAC00, SYL_END = 0xD7A3;
  const JAMO_START = 0x3131, JAMO_END = 0x314E;

  /** 소문자 한 글자로 정규화(길이 보존) */
  function lowerChar(ch) {
    const low = ch.toLowerCase();
    return low.length === 1 ? low : ch;
  }

  /**
   * 문자열을 '초성 문자열'로 바꾼다. 한글 음절은 초성으로,
   * 그 외 글자는 소문자 그대로 두어 원문과 글자 수가 일치한다.
   */
  function choseong(str) {
    let out = '';
    for (const ch of str) {
      const code = ch.codePointAt(0);
      if (code >= SYL_START && code <= SYL_END) {
        out += CHO[Math.floor((code - SYL_START) / 588)];
      } else {
        out += lowerChar(ch);
      }
    }
    return out;
  }

  /**
   * 초성 검색어인지 판단한다.
   * 자모(ㄱ~ㅎ)가 하나 이상 있고, 완성형 음절이 섞여 있지 않아야 한다.
   * 모음(ㅏ~ㅣ)이 섞이면 초성 검색이 아니다.
   */
  function isChoseongQuery(q) {
    let hasJamo = false;
    for (const ch of q) {
      const code = ch.codePointAt(0);
      if (code >= SYL_START && code <= SYL_END) return false;
      if (code >= JAMO_START && code <= 0x3163) {
        if (code >= JAMO_START && code <= JAMO_END && CHO.includes(ch)) {
          hasJamo = true;
        } else {
          return false; // 모음이나 겹받침 자모
        }
      }
    }
    return hasJamo;
  }

  /** 색인에서 쓸 대표 글자(ㄱㄴㄷ / A-Z / #)를 구한다 */
  function indexLetter(str) {
    const trimmed = (str || '').trim();
    if (!trimmed) return '#';
    const ch = [...trimmed][0];
    const code = ch.codePointAt(0);
    if (code >= SYL_START && code <= SYL_END) {
      const cho = CHO[Math.floor((code - SYL_START) / 588)];
      return CHO_BASE[cho] || cho;
    }
    if (code >= JAMO_START && code <= JAMO_END) {
      const base = CHO_BASE[ch] || JAMO_BASE[ch] || ch;
      return INDEX_ORDER.includes(base) ? base : '#';
    }
    const up = ch.toUpperCase();
    if (up >= 'A' && up <= 'Z' && up.length === 1) return up;
    return '#';
  }

  /**
   * 빈칸을 무시하고 초성으로 찾는다.
   * 맞는 곳이 있으면 원문 기준 { index, length }를, 없으면 null을 돌려준다.
   * 예: "양자 얽힘"에서 "ㅇㅈㅇㅎ"을 찾으면 index 0, length 5(빈칸 포함).
   */
  function choseongFind(target, query) {
    const cho = choseong(target);
    let stripped = '';
    const map = [];
    for (let i = 0; i < cho.length; i++) {
      if (/\s/.test(cho[i])) continue;
      stripped += cho[i];
      map.push(i);
    }
    const q = choseong(query).replace(/\s+/g, '');
    if (!q) return null;
    const si = stripped.indexOf(q);
    if (si < 0) return null;
    const start = map[si];
    const end = map[si + q.length - 1];
    return { index: start, length: end - start + 1 };
  }

  return { CHO, INDEX_ORDER, choseong, isChoseongQuery, indexLetter, choseongFind };
})();
