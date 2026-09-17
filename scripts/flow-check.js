/* ===== scripts/flow-check.js — 畫面流程、RWD 與設定的靜態檢查 =====
 * 抓的是那種「跑起來才發現按鈕沒反應」的低級錯誤：
 * 程式抓了一個 index.html 裡不存在的 id、某個畫面沒有回去的路、
 * 觸控命中區太小、server URL 被寫死等等。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
/** 去掉註解再檢查，不然「不做 localhost 回退」這種說明文字會被誤判成寫死網址 */
const code = f => read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  OK   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  → ' + extra : '')); }
}

const html = read('public/index.html');
const css = read('public/css/style.css');
const app = read('public/js/app.js');
const online = read('public/js/online.js');

console.log('畫面流程與 RWD\n');

/* ---------- 1. 程式抓的 id 都要真的存在 ---------- */
const ids = new Set();
const idRe = /id="([^"]+)"/g;
let m;
while ((m = idRe.exec(html))) ids.add(m[1]);

const used = new Set();
for (const src of [app, online]) {
  const re = /\$\('([^']+)'\)/g;
  let k;
  while ((k = re.exec(src))) used.add(k[1]);
}
const missing = [...used].filter(id => !ids.has(id));
ok('程式抓的 ' + used.size + ' 個 id 全部存在於 index.html', missing.length === 0, missing.join(', '));

/* ---------- 2. 每個畫面都有回去的路 ---------- */
const SCREENS = ['home', 'setup', 'help', 'lobby', 'room', 'race', 'result'];
for (const s of SCREENS) ok('有 screen-' + s + ' 這個畫面', ids.has('screen-' + s));
ok('設定頁有回首頁', ids.has('setup-back'));
ok('怎麼玩有回首頁', ids.has('help-back'));
ok('大廳有回首頁', ids.has('lobby-back'));
ok('房間有離開房間', ids.has('room-back'));
ok('結算有再來一局與回首頁', ids.has('again') && ids.has('result-home'));
ok('首頁有回遊戲大廳的連結', ids.has('lobby-home-link') &&
  /<a id="lobby-home-link"[^>]*href="https:\/\/[^"]*game-lobby/.test(html));
ok('回大廳連結只在首頁出現', /lobbyLink\.hidden = \(name !== 'home'\)/.test(app));
ok('回大廳連結不會被 display 蓋掉', /\.lobby-home-link\[hidden\]/.test(css));
ok('比賽中 Esc 開暫停選單', /onPause/.test(app) && ids.has('modal-pause'));
ok('暫停選單只有繼續／重新開始／回首頁三顆',
  ids.has('pause-resume') && ids.has('pause-restart') && ids.has('pause-home'));

/* ---------- 3. 右上角設定 ---------- */
ok('右上角有設定按鈕', ids.has('btn-gear'));
ok('設定是 Modal 不是另一個路由', /id="modal-settings"[^>]*role="dialog"/.test(html));
ok('設定 Modal 有 aria-modal', /id="modal-settings"[^>]*aria-modal="true"/.test(html));
ok('設定 Modal 有遮罩', /id="modal-settings"[\s\S]*?modal-mask/.test(html));
ok('設定 Modal 有焦點鎖定與 Esc 關閉', /function modal\(/.test(read('public/js/svgui.js')) &&
  /Escape/.test(read('public/js/svgui.js')) && /Tab/.test(read('public/js/svgui.js')));
ok('關閉後焦點回到原本的按鈕', /lastFocus\.focus\(\)/.test(read('public/js/svgui.js')));
for (const id of ['set-vibrate', 'set-sens', 'set-cam', 'set-zoom', 'set-motion', 'set-color', 'set-bigtext', 'set-bad', 'set-clear', 'set-reset']) {
  ok('設定裡有 ' + id, ids.has(id));
}

/* ---------- 4. 對戰畫面的資訊配置：Summary 與聊天都在左側 ---------- */
ok('有操作 Summary', ids.has('summary'));
ok('Summary 顯示名次、圈數、本圈時間、道具、蠕動槽',
  ['my-rank', 'my-lap', 'lap-time', 'sum-item', 'wiggle-gauge', 'standings'].every(id => ids.has(id)));
ok('Summary 靠左', /\.summary\s*\{[^}]*left:/.test(css));
ok('聊天室在左下', /\.chat-dock\s*\{[^}]*left:[^}]*bottom:/.test(css));
ok('聊天有未讀數', ids.has('chat-unread'));
ok('窄版 Summary 可以收合', ids.has('sum-toggle') && /\.sum-toggle\s*\{\s*display:\s*none/.test(css));
ok('有小地圖（鏡頭會轉，需要不轉的參考）', ids.has('minimap'));

/* ---------- 5. 觸控 ---------- */
ok('有左右兩顆轉向鍵與道具鍵', ids.has('btn-left') && ids.has('btn-right') && ids.has('btn-item'));
const tbtn = css.match(/\.tbtn\s*\{[\s\S]*?\}/)[0];
const size = Number((tbtn.match(/width:\s*(\d+)px/) || [])[1] || 0);
ok('轉向鍵夠大（>= 72px）', size >= 72, size + 'px');
ok('轉向鍵貼左下與右下', /\.tbtn\.left\s*\{[^}]*left:/.test(css) && /\.tbtn\.right\s*\{[^}]*right:/.test(css));
ok('觸控不會選到文字或捲動', /touch-action:\s*none/.test(css));
ok('有 safe-area 內距', /env\(safe-area-inset/.test(css));
ok('按鍵有 aria-label', /id="btn-left"[^>]*aria-label/.test(html) && /id="btn-right"[^>]*aria-label/.test(html));

/* ---------- 6. RWD ---------- */
ok('有平板／桌機的寬版排版', /@media \(min-width: 900px\)/.test(css));
ok('有手機窄版排版', /@media \(max-width: 560px\)/.test(css));
ok('有直向專用排版', /@media \(orientation: portrait\)/.test(css));
ok('有橫向矮螢幕排版', /@media \(orientation: landscape\)/.test(css));
ok('有 viewport-fit=cover', /viewport-fit=cover/.test(html));
ok('尊重系統的減少動態設定', /prefers-reduced-motion/.test(css));
ok('直向小螢幕會提示轉橫向', ids.has('rotate-tip'));
ok('隱藏元素不會被 display 蓋掉',
  /\.rotate-tip\[hidden\]/.test(css) && /\.big-btn\[hidden\]/.test(css) && /\.countdown\[hidden\]/.test(css));

/* ---------- 7. server URL 參數化 ---------- */
const config = read('public/js/config.js');
ok('server URL 只從 config.js 來', /GAME_SERVER_URL:BEGIN/.test(config));
ok('config 會檢查網址格式', /必須是 http\/https/.test(config));
ok('https 頁面不接受 http 伺服器', /混合內容/.test(config));
ok('沒有 localhost 回退', !/localhost/.test(code('public/js/config.js')));
for (const f of ['public/js/app.js', 'public/js/online.js', 'public/js/net.js']) {
  ok(f + ' 沒有寫死網址', !/https?:\/\/(?!cdnjs|www\.w3)/.test(code(f)), '');
}
ok('WebSocket 網址由 config 換算，不用字串猜協定', /toWs/.test(config) && /Config\.wsUrl/.test(online));

/* ---------- 8. 線上角色與邀請 ---------- */
ok('房間有玩家席位與觀戰席', ids.has('seat-list') && ids.has('spec-list'));
ok('可以在玩家與觀戰之間切換', ids.has('room-switch'));
ok('有邀請連結按鈕', ids.has('room-invite'));
ok('邀請連結帶 room 與 token 兩個參數', /room=.*t=/.test(online));
ok('房主才看得到房間設定', /room-owner-only/.test(html) && /ownerBox\.hidden = !room\.isOwner/.test(online));

console.log('\n畫面流程：' + pass + ' 通過，' + fail + ' 失敗');
process.exit(fail ? 1 : 0);
