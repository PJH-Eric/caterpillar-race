/* ===== svgui.js — 共用 SVG 圖示、立體按鈕與 Modal =====
 * 一律線稿或實心手繪路徑，不用 emoji（每台裝置長得都不一樣，還會跟著系統字體跑掉）。
 */
(function (root) {
  'use strict';

  function gearIcon() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8.5A3.5 3.5 0 1 0 12 15.5 3.5 3.5 0 0 0 12 8.5Zm8.4 3.5a8.4 8.4 0 0 0-.1-1.2l2-1.5-2-3.4-2.3.9a8.2 8.2 0 0 0-2-1.2L15.6 3h-3.9l-.4 2.6a8.2 8.2 0 0 0-2 1.2l-2.3-.9-2 3.4 2 1.5a8.4 8.4 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-.9a8.2 8.2 0 0 0 2 1.2l.4 2.6h3.9l.4-2.6a8.2 8.2 0 0 0 2-1.2l2.3.9 2-3.4-2-1.5c.06-.4.1-.8.1-1.2Z"/></svg>';
  }
  /** 暫停：兩條直條。比賽中那顆按鈕用的 */
  function pauseIcon() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="5" width="3.6" height="14" rx="1.4"/><rect x="13.4" y="5" width="3.6" height="14" rx="1.4"/></svg>';
  }
  function closeIcon() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" fill="none"/></svg>';
  }
  /** 轉向鍵的箭頭：兩條互為鏡像的路徑，左右鍵的留白完全一樣，不用任何 transform */
  /** dir: -1 左、1 右；axis 給 'up' / 'down' 就變成上下箭頭（電腦版的油門與煞車） */
  function arrowIcon(dir, axis) {
    const d = axis === 'up' ? 'M10 34 24 14 38 34z'
      : axis === 'down' ? 'M10 14 24 34 38 14z'
        : (dir < 0 ? 'M34 10 14 24 34 38z' : 'M14 10 34 24 14 38z');
    return '<svg viewBox="0 0 48 48" aria-hidden="true">' +
      '<path d="' + d + '" fill="currentColor"/>' +
      '<path d="' + d + '" fill="none" stroke="rgba(0,0,0,.25)" stroke-width="2" stroke-linejoin="round"/></svg>';
  }
  function flagIcon() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3v18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" fill="none"/><path d="M8 4h11l-2.4 4L19 12H8z" fill="currentColor"/></svg>';
  }
  function starIcon(filled) {
    return '<svg viewBox="0 0 24 24" class="star" aria-hidden="true"><path d="M12 3l2.7 5.8 6.3.8-4.6 4.3 1.2 6.3L12 17.2 6.4 20.2l1.2-6.3L3 9.6l6.3-.8z" fill="' +
      (filled ? 'currentColor' : 'none') + '" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  }
  function settingIcon(kind) {
    const wrap = inner =>
      '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';
    if (kind === 'sound') return wrap('<path d="M5 9.5h3l4.5-3.5v12L8 14.5H5z"/><path d="M16.5 9a4 4 0 0 1 0 6"/><path d="M19 6.5a7.5 7.5 0 0 1 0 11"/>');
    if (kind === 'feel') return wrap('<path d="M12 4.5v15"/><path d="M7.5 8v8M16.5 8v8"/><path d="M3.5 10.5v3M20.5 10.5v3"/>');
    if (kind === 'see') return wrap('<path d="M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.8"/>');
    if (kind === 'play') return wrap('<path d="M5 4.5h14v15H5z"/><path d="M9 9h6M9 13h6"/>');
    return wrap('<path d="M4.5 6.5c0-1.7 3.4-3 7.5-3s7.5 1.3 7.5 3-3.4 3-7.5 3-7.5-1.3-7.5-3Z"/><path d="M4.5 6.5v11c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-11"/><path d="M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3"/>');
  }

  /** 道具圖示：六種各一個手繪造型，不共用 */
  function itemIcon(id, size) {
    const s = size || 40;
    const open = '<svg viewBox="0 0 48 48" width="' + s + '" height="' + s + '" class="item-icon" aria-hidden="true">';
    if (id === 'juice') return open +
      '<path d="M14 12h20l-3 26a4 4 0 0 1-4 3.4h-6a4 4 0 0 1-4-3.4z" fill="#FFB259" stroke="#C96A11" stroke-width="2"/>' +
      '<path d="M15 19h18l-.7 6H15.7z" fill="#FFE0B0"/>' +
      '<path d="M30 8l6-3" stroke="#8BD44A" stroke-width="3" stroke-linecap="round"/></svg>';
    if (id === 'shield') return open +
      '<circle cx="24" cy="25" r="15" fill="rgba(160,225,255,.5)" stroke="#5FB8F0" stroke-width="2.4"/>' +
      '<circle cx="18" cy="19" r="4.4" fill="#fff" opacity=".9"/>' +
      '<circle cx="34" cy="13" r="4" fill="rgba(160,225,255,.6)" stroke="#5FB8F0" stroke-width="1.6"/></svg>';
    if (id === 'hop') return open +
      '<path d="M24 41c-11-4-16-13-15-24 12-2 21 3 24 12 2 7 0 10-9 12z" fill="#9BE36A" stroke="#4F9420" stroke-width="2"/>' +
      '<path d="M10 18q10 10 14 23" stroke="#4F9420" stroke-width="2" fill="none"/></svg>';
    if (id === 'goo') return open +
      '<ellipse cx="16" cy="32" rx="9" ry="7" fill="#C79BE8" stroke="#7B4BB0" stroke-width="2"/>' +
      '<ellipse cx="31" cy="36" rx="7" ry="5.5" fill="#C79BE8" stroke="#7B4BB0" stroke-width="2"/>' +
      '<ellipse cx="28" cy="21" rx="6" ry="5" fill="#C79BE8" stroke="#7B4BB0" stroke-width="2"/></svg>';
    if (id === 'web') return open +
      '<g stroke="#8E97A6" stroke-width="2" fill="none"><path d="M24 6v36M6 24h36M11 11l26 26M37 11L11 37"/>' +
      '<path d="M24 13l8 5 3 9-6 8-10 0-6-8 3-9z"/><path d="M24 19l4 3 1.4 5-3 4h-5l-3-4 1.4-5z"/></g></svg>';
    if (id === 'tiny') return open +
      '<path d="M24 8a16 16 0 1 0 12 26" fill="none" stroke="#F06292" stroke-width="3.2" stroke-linecap="round"/>' +
      '<path d="M32 30l6 6-9 2z" fill="#F06292"/>' +
      '<circle cx="24" cy="24" r="5" fill="#FFC1D8" stroke="#F06292" stroke-width="2"/></svg>';
    /* 不認識的 id：畫一個問號方塊，不要默默拿別的道具的圖頂替 */
    return open +
      '<rect x="10" y="10" width="28" height="28" rx="7" fill="none" stroke="#9AA2AE" stroke-width="2.6"/>' +
      '<path d="M20 20a4 4 0 1 1 5 4v3" fill="none" stroke="#9AA2AE" stroke-width="2.6" stroke-linecap="round"/>' +
      '<circle cx="25" cy="32" r="1.8" fill="#9AA2AE"/></svg>';
  }

  /** Modal：遮罩、焦點鎖定、Esc 關閉、關閉後焦點回到原本的按鈕 */
  function modal(el, opener, options) {
    options = options || {};
    let lastFocus = opener || null;
    const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

    function items() {
      return [].slice.call(el.querySelectorAll(FOCUSABLE)).filter(n => !n.disabled && n.offsetParent !== null);
    }
    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation(); close();
        if (typeof options.onEscape === 'function') options.onEscape();
        return;
      }
      if (e.key !== 'Tab') return;
      const list = items();
      if (!list.length) return;
      const first = list[0], last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    function open(from) {
      lastFocus = from || lastFocus || document.activeElement;
      el.hidden = false;
      el.classList.add('open');
      document.addEventListener('keydown', onKey, true);
      const list = items();
      if (list.length) list[0].focus();
    }
    function close() {
      el.classList.remove('open');
      el.hidden = true;
      document.removeEventListener('keydown', onKey, true);
      if (lastFocus && lastFocus.focus) lastFocus.focus();
    }
    return { open, close, get isOpen() { return !el.hidden; } };
  }

  root.SvgUI = { gearIcon, pauseIcon, closeIcon, arrowIcon, flagIcon, starIcon, settingIcon, itemIcon, modal };
})(typeof self !== 'undefined' ? self : this);
