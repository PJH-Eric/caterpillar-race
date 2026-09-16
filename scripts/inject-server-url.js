/* ===== scripts/inject-server-url.js — 建置時把 GAME_SERVER_URL 注入 config.js =====
 *
 * GitHub Pages 的建置流程會跑這一支，把前端要連的伺服器網址寫進 public/js/config.js
 * 那一行 INJECTED。本機開發不用跑，config.js 會自己用同源。
 *
 * 用法：GAME_SERVER_URL=https://xxx.onrender.com node scripts/inject-server-url.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const url = (process.env.GAME_SERVER_URL || '').trim();
const file = path.join(__dirname, '../public/js/config.js');

if (!url) {
  console.log('沒有設定 GAME_SERVER_URL，config.js 不動（前端會用同源）。');
  process.exit(0);
}
if (!/^https?:\/\//i.test(url)) {
  console.error('GAME_SERVER_URL 必須是 http/https 開頭的絕對網址，收到的是：' + url);
  process.exit(1);
}
if (/localhost|127\.0\.0\.1/i.test(url)) {
  console.error('正式建置不可以注入 localhost：' + url);
  process.exit(1);
}

const src = fs.readFileSync(file, 'utf8');
const re = /(\/\* GAME_SERVER_URL:BEGIN[^\n]*\n)[\s\S]*?(\n\s*\/\* GAME_SERVER_URL:END)/;
if (!re.test(src)) {
  console.error('config.js 裡找不到 GAME_SERVER_URL:BEGIN／END 標記，請不要改那段的格式。');
  process.exit(1);
}
const out = src.replace(re, (all, a, b) => a + "  var INJECTED = '" + url.replace(/\/+$/, '') + "';" + b);
fs.writeFileSync(file, out);
console.log('已把 server URL 注入 config.js：' + url);
