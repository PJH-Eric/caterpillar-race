/* ===== input.js — 鍵盤 ＋ 左右兩顆觸控轉向鍵 ＋ 道具鍵 =====
 *
 * 觸控：毛毛蟲自己往前，只要左轉、右轉、用道具。
 * 電腦：方向鍵四顆都有用 —— 上＝催、下＝煞車倒退、左右＝轉向；道具改成空白鍵。
 * 道具是「邊緣觸發」——按一次算一次，按著不放不會連發。
 */
(function (root) {
  'use strict';

  function create(opt) {
    opt = opt || {};
    const state = {
      left: false, right: false,
      up: false, down: false,
      useQueued: false,
      /* 觸控時哪一顆按鍵被哪根手指按著，多指同按才不會互相取消 */
      pointers: {}
    };
    const handlers = { pause: opt.onPause || function () {} };

    function setDir(dir, down) {
      if (dir === 'left') state.left = down;
      else if (dir === 'right') state.right = down;
      else if (dir === 'up') state.up = down;
      else if (dir === 'down') state.down = down;
    }

    /* ---------- 鍵盤 ---------- */
    function onKey(e, down) {
      const k = e.key;
      if (k === 'ArrowLeft' || k === 'a' || k === 'A') { setDir('left', down); e.preventDefault(); }
      else if (k === 'ArrowRight' || k === 'd' || k === 'D') { setDir('right', down); e.preventDefault(); }
      else if (k === 'ArrowUp' || k === 'w' || k === 'W') { setDir('up', down); e.preventDefault(); }
      else if (k === 'ArrowDown' || k === 's' || k === 'S') { setDir('down', down); e.preventDefault(); }
      else if (k === ' ' || k === 'Shift' || k === 'Enter') {
        if (down && !e.repeat) state.useQueued = true;
        e.preventDefault();
      } else if (k === 'Escape' && down) {
        handlers.pause();
      }
    }
    const kd = e => onKey(e, true);
    const ku = e => onKey(e, false);

    /* ---------- 觸控 ---------- */
    function bindButton(el, dir) {
      if (!el) return;
      const down = e => {
        el.classList.add('down');
        state.pointers[e.pointerId] = dir;
        if (dir === 'item') state.useQueued = true;
        else setDir(dir, true);
        if (el.setPointerCapture) { try { el.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ } }
        e.preventDefault();
      };
      const up = e => {
        el.classList.remove('down');
        const d = state.pointers[e.pointerId];
        delete state.pointers[e.pointerId];
        if (d && d !== 'item') setDir(d, false);
        e.preventDefault();
      };
      el.addEventListener('pointerdown', down);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      el.addEventListener('pointerleave', up);
      el.addEventListener('contextmenu', e => e.preventDefault());
    }

    function attach(els) {
      root.addEventListener('keydown', kd);
      root.addEventListener('keyup', ku);
      /* 分頁被切走時把按鍵全放開，回來才不會卡住一直轉 */
      root.addEventListener('blur', releaseAll);
      bindButton(els.left, 'left');
      bindButton(els.right, 'right');
      bindButton(els.item, 'item');
    }

    function detach() {
      root.removeEventListener('keydown', kd);
      root.removeEventListener('keyup', ku);
      root.removeEventListener('blur', releaseAll);
    }

    function releaseAll() {
      state.left = false; state.right = false;
      state.up = false; state.down = false;
      state.pointers = {};
    }

    /** 取這一個 tick 的輸入；道具的 use 取過就清掉 */
    function read() {
      const steer = (state.left ? -1 : 0) + (state.right ? 1 : 0);
      /* gas：0 是「不碰油門」＝原本的自動前進，觸控永遠是 0 */
      const gas = (state.down ? -1 : 0) + (state.up ? 1 : 0);
      const use = state.useQueued;
      state.useQueued = false;
      return { steer, gas, use };
    }

    /** 不消耗地看一眼（畫面要標示按鍵有沒有被按住） */
    function peek() {
      return { left: state.left, right: state.right, up: state.up, down: state.down };
    }

    return { attach, detach, read, peek, releaseAll, state, onPause(fn) { handlers.pause = fn; } };
  }

  root.Input = { create };
})(typeof self !== 'undefined' ? self : this);
