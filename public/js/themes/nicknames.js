/* ===== themes/nicknames.js — 隨機可愛暱稱（形容詞＋小動物） ===== */
(function (root) {
  'use strict';
  const ADJ = ['快快', '圓圓', '毛毛', '軟軟', '蹦蹦', '呼呼', '滾滾', '咻咻', '慢慢', '亮亮', '胖胖', '小小'];
  const ANIMAL = ['毛蟲', '蝸牛', '瓢蟲', '蚱蜢', '蜜蜂', '螞蟻', '蝴蝶', '甲蟲', '蜻蜓', '蠶寶'];

  function random(rand) {
    const r = rand || Math.random;
    return ADJ[Math.floor(r() * ADJ.length)] + ANIMAL[Math.floor(r() * ANIMAL.length)];
  }
  const api = { ADJ, ANIMAL, random };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Nicknames = api;
})(typeof self !== 'undefined' ? self : this);
