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
const input = read('public/js/input.js');
const protocol = read('lib/protocol.js');

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
ok('結算有再來一局、回房間與回首頁', ids.has('again') && ids.has('result-room') && ids.has('result-home'));
ok('首頁有回遊戲大廳的連結', ids.has('lobby-home-link') &&
  /<a id="lobby-home-link"[^>]*href="https:\/\/[^"]*game-lobby/.test(html));
ok('回大廳連結只在首頁出現', /lobbyLink\.hidden = \(name !== 'home'\)/.test(app));
ok('回大廳連結不會被 display 蓋掉', /\.lobby-home-link\[hidden\]/.test(css));
ok('比賽中 Esc 開暫停選單', /onPause/.test(app) && ids.has('modal-pause'));
ok('暫停選單有繼續／重新開始／回房間／回首頁',
  ids.has('pause-resume') && ids.has('pause-restart') && ids.has('pause-room') && ids.has('pause-home'));

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

/* ---------- 3b. 結算浮層：疊在賽道畫面上，不換場景 ---------- */
{
  const race = html.slice(html.indexOf('id="screen-race"'), html.indexOf('id="screen-result"'));
  ok('結算浮層在賽道畫面裡（不是獨立頁）', race.includes('id="race-result"'));
  for (const id of ['rr-list', 'rr-again', 'rr-room', 'rr-leave', 'rr-more']) {
    ok('結算浮層有 ' + id, race.includes('id="' + id + '"'));
  }
  const app = read('public/js/app.js');
  ok('單機與線上都走同一個浮層', /showRaceResult\(G\.lastResults\)/.test(app));
  ok('線上「再玩一場」就地準備，不跳頁', /readyAgain\(\)/.test(app));
  ok('詳細結算頁可以回房間', /\$\('result-room'\)\.addEventListener/.test(app) && /backToRoom\(\)/.test(app));
}

/* ---------- 4. 對戰畫面的資訊配置：Summary 與聊天都在左側 ---------- */
ok('有操作 Summary', ids.has('summary'));
ok('Summary 顯示名次、圈數、本圈時間、道具、名次表',
  ['my-rank', 'my-lap', 'lap-time', 'sum-item', 'standings'].every(id => ids.has(id)));
ok('蠕動衝刺已經完全移除', !/wiggle-gauge/.test(html) && !/蠕動/.test(html) &&
  !/WIGGLE/.test(read('public/js/rules.js')) && !/wiggle-gauge/.test(css));

/* 手機沒有鍵盤，Esc 能做的事一定要有按鈕按得到 */
ok('比賽中有畫面上的暫停鍵', ids.has('btn-pause') && /btn-pause.*togglePause|togglePause/.test(app));
ok('暫停鍵跟 Esc 走同一個入口',
  /\$\('btn-pause'\)\.addEventListener\('click'[\s\S]{0,120}togglePause\(\)/.test(app) &&
  /onPause/.test(app));
ok('暫停選單可以回房間', /\$\('pause-room'\)\.addEventListener/.test(app) && /backToRoom\(\)/.test(app));
ok('暫停鍵只在比賽中、而且只在單機出現',
  /pauseBtn\.hidden = !\(D\.body\.dataset\.screen === 'race' && G\.mode !== 'online'/.test(app));
ok('暫停鍵不會壓到齒輪', /#btn-pause \{[^}]*right:/.test(css));
ok('Summary 靠左', /\.summary\s*\{[^}]*left:/.test(css));
ok('聊天室在左下', /\.chat-dock\s*\{[^}]*left:[^}]*bottom:/.test(css));
ok('房間聊天室有獨立區塊', ids.has('room-chat-log') && /class="panel room-chat"/.test(html));
ok('房間寬版聊天室排在左欄', /\.room-chat\s*\{[^}]*grid-column:\s*1[^}]*grid-row:\s*2/.test(css));
ok('房間寬版賽道選擇保留在右欄', /\.room-track-panel\s*\{[^}]*grid-column:\s*2/.test(css));
ok('房間聊天室高度依內容調整',
  /\.room-body\s*\{[^}]*grid-template-rows:\s*max-content auto auto/.test(css) &&
  /\.room-chat\s*\{[^}]*min-height:\s*0/.test(css) &&
  /\.room-chat \.chat-log\s*\{[^}]*max-height:\s*120px[^}]*min-height:\s*0/.test(css));
ok('聊天室按 Enter 可以送出訊息',
  /isTextEntry\(e\)/.test(input) && /k !== 'Escape'/.test(input) &&
  /form\.addEventListener\('submit'/.test(online));
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
ok('房間有玩家席位與圖片賽道選擇', ids.has('seat-list') && ids.has('room-track-grid') && !ids.has('spec-list'));
ok('房間不提供圈數與賽道下拉選單', !ids.has('room-laps') && !ids.has('room-track'));
ok('觀戰者仍可加入玩家席位', ids.has('room-switch'));
ok('有邀請連結按鈕', ids.has('room-invite'));
ok('邀請連結帶 room 與 token 兩個參數', /room=.*t=/.test(online));
ok('房主才看得到房間設定', /room-owner-only/.test(html) && /ownerBox\.hidden = !room\.isOwner/.test(online));
ok('房主要按開始遊戲、玩家各自準備',
  ids.has('room-start') && /room-start/.test(online) && /type: 'start'/.test(online) && /start\(person\)/.test(protocol));
ok('房間人數上限使用客製化下拉選單',
  ids.has('room-seats-trigger') && ids.has('room-seats-menu') &&
  /id="room-seats"[^>]*hidden/.test(html) && /buildSeatPicker/.test(online) && /\.select-menu\s*\{/.test(css));

/* ---------- 9. 賽道分頁 ---------- */
{
  const Tracks = require('../public/js/tracks.js');
  ok('單機與房間都有賽道分頁', ids.has('track-tabs') && ids.has('room-track-tabs'));
  ok('兩邊共用同一支 buildTrackGrid', /App\.buildTrackGrid\(grid/.test(online) && /function buildTrackGrid/.test(app));
  ok('分頁放不下會換行，不是橫向捲', /\.track-tabs\s*\{[^}]*flex-wrap:\s*wrap/.test(css) &&
    !/\.track-tabs\s*\{[^}]*overflow-x:\s*auto/.test(css));
  ok('賽道格子依視窗可用高度展開，只有放不下才捲動',
    /\.track-grid\s*\{[^}]*max-height:\s*min\(calc\(100vh - 170px\), 520px\)[^}]*overflow-y:\s*auto/.test(css));
  ok('賽道格子自己捲動，不會把整頁撐長', /\.track-grid\s*\{[^}]*max-height/.test(css) &&
    /\.track-grid\s*\{[^}]*overflow-y:\s*auto/.test(css));
  ok('分頁狀態記在格子上（單機與房間各記各的）', /grid\.dataset\.tab/.test(app));
  ok('開啟時會跳到目前選的賽道所在分頁', /Tracks\.groupOf\(cur\)/.test(app));

  /* 每張賽道都要被某個分頁收走，不然會在「全部」以外看不到 */
  const lost = Tracks.TRACKS.filter(d => Tracks.groupOf(d) === 'all').map(d => d.id + '(' + d.theme + ')');
  ok('每張賽道都歸得到一個分頁', lost.length === 0, lost.join(', '));
  const counts = {};
  for (const d of Tracks.TRACKS) counts[Tracks.groupOf(d)] = (counts[Tracks.groupOf(d)] || 0) + 1;
  const empty = Tracks.GROUPS.filter(g => g.themes && !counts[g.id]).map(g => g.name);
  ok('沒有空的分頁', empty.length === 0, empty.join(', '));
  ok('衝刺賽道在卡片上標「單程」不是圈數', /def\.open \? '單程'/.test(app));
  ok('衝刺賽道的縮圖不畫成封閉迴圈', /def\.open \? 'polyline' : 'polygon'/.test(app));
}

console.log('\n畫面流程：' + pass + ' 通過，' + fail + ' 失敗');
process.exit(fail ? 1 : 0);
