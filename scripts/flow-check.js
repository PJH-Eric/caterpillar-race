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
for (const id of ['set-vibrate', 'set-sens', 'set-zoom', 'set-motion', 'set-color', 'set-bigtext', 'set-bad', 'set-clear', 'set-reset']) {
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
ok('Summary 顯示名次、圈數、本圈時間、本場總秒數、道具、名次表',
  ['my-rank', 'my-lap', 'lap-time', 'race-total-time', 'sum-item', 'standings'].every(id => ids.has(id)) &&
  /本場總秒數/.test(html));
ok('選手完賽後固定計時，本場總秒數跑到最後一位',
  /me\.finished \|\| st\.phase === 'finished'/.test(app) &&
  /me\.finishTime \|\| st\.raceT/.test(app) && /race-total-time/.test(app));
ok('蠕動衝刺已經完全移除', !/wiggle-gauge/.test(html) && !/蠕動/.test(html) &&
  !/WIGGLE/.test(read('public/js/rules.js')) && !/wiggle-gauge/.test(css));

/* 手機沒有鍵盤，Esc 能做的事一定要有按鈕按得到 */
ok('比賽中有畫面上的暫停鍵', ids.has('btn-pause') && /btn-pause.*togglePause|togglePause/.test(app));
ok('暫停鍵跟 Esc 走同一個入口',
  /\$\('btn-pause'\)\.addEventListener\('click'[\s\S]{0,120}togglePause\(\)/.test(app) &&
  /onPause/.test(app));
ok('暫停選單可以回房間', /\$\('pause-room'\)\.addEventListener/.test(app) && /backToRoom\(\)/.test(app));
ok('暫停鍵只在比賽中、而且只在單機出現',
  /pauseBtn\.hidden = !\(D\.body\.dataset\.screen === 'race' && G\.mode !== 'online'/.test(app) &&
  /G\.state\.phase === 'racing'/.test(app) && /!G\.paused/.test(app) && /\.gear\[hidden\]\s*\{\s*display:\s*none/.test(css));
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


/* ---------- 起跑燈架 ---------- */
{
  const CD_PODS = 3;
  /* 三段 CSS 規則先撈出來，下面好幾條檢查都要用 */
  const cdRule = css.slice(css.indexOf('.countdown {'), css.indexOf('.countdown[hidden]'));
  const gantryRule = css.slice(css.indexOf('.cd-gantry {'), css.indexOf('.cd-gantry {') + 420);
  const lampRule = css.slice(css.indexOf('.cd-pod i {'), css.indexOf('.cd-pod.on i'));
  const onRule = css.slice(css.indexOf('.cd-pod.on i'), css.indexOf('.cd-pod.on i') + 460);

  ok('起跑用燈架不是數字倒數', html.includes('cd-gantry'));
  const pods = (html.match(/class="cd-pod"/g) || []).length;
  ok('燈架有三組燈柱', pods === CD_PODS, pods);
  /* 一排燈，一組一顆（不是上下兩排） */
  const lamps = (html.match(/class="cd-pod" data-pod="\d"><i><\/i><\/div>/g) || []).length;
  ok('一組燈柱就一顆燈（只有一排）', lamps === CD_PODS, lamps);
  ok('燈架是一排（flex 橫向排）', gantryRule.includes('display: flex'));

  /* 倒數不能蓋到賽道與毛毛蟲：地平線在畫面三分之一處，燈架要收在那之上。
   * place-items: center 會把燈架放在畫面正中央 —— 那正好是毛毛蟲的位置。 */
  ok('倒數靠上排，不是置中（置中會蓋到毛毛蟲）',
    cdRule.includes('align-content: start') && !cdRule.includes('place-items: center'));
  ok('倒數有留上方安全區', cdRule.includes('--safe-t'));

  /* 燈要夠小才不會擋畫面：燈架總高（燈 ＋ 內距 ＋ 邊框 ＋ 上方留白）
   * 要收在地平線（33%）以上。橫向時 vmin ＝ 畫面高，所以直接用 vmin 換算。 */
  const lampVmin = parseFloat((lampRule.match(/width:\s*([\d.]+)vmin/) || [])[1]);
  ok('燈的尺寸用 vmin 指定', !isNaN(lampVmin), lampVmin);
  ok('單顆燈不超過畫面短邊的 6%', lampVmin <= 6, lampVmin + 'vmin');
  const padVmin = parseFloat((gantryRule.match(/padding:\s*([\d.]+)vmin/) || [])[1]) || 0;
  const topVmin = parseFloat((cdRule.match(/\+\s*([\d.]+)vmin\)/) || [])[1]) || 0;
  const totalVmin = topVmin + lampVmin + padVmin * 2 + 3;   /* +3 給吊桿與邊框 */
  ok('燈架整個收在地平線以上（不蓋到路面）', totalVmin < 33,
    '約佔畫面短邊 ' + totalVmin.toFixed(1) + '%，地平線在 33%');
  ok('亮燈與熄燈有分開的樣式', css.includes('.cd-pod i') && css.includes('.cd-pod.on i'));

  /* 吊桿：讓燈架看起來是吊著的，不是浮在空中 */
  ok('燈架有吊桿', html.includes('cd-hang') && css.includes('.cd-hang i'));

  /* 亮燈一定要有光暈，不然只是換個紅色，看不出「亮起來了」 */
  ok('亮燈有光暈', onRule.includes('box-shadow') && onRule.includes('rgba(255'));

  /* 尺寸用 vmin：直的橫的、手機平板桌機都是同一組數字 */
  ok('燈架尺寸用 vmin（直橫向與各種螢幕共用一組數字）',
    gantryRule.includes('vmin') && css.slice(css.indexOf('.cd-pod i {')).slice(0, 300).includes('vmin'));

  ok('燈號另外播報文字給讀螢幕的人', html.includes('cd-sr') && css.includes('.cd-sr'));
  ok('燈架對讀螢幕的人是隱藏的（燈號本身沒有語意）',
    html.includes('cd-rig" aria-hidden="true"'));

  ok('燈號時間從 C.COUNTDOWN 推算（倒數改長短不用動這裡）',
    app.includes('total / CD_PODS') && app.includes('Rules.C.COUNTDOWN'));
  ok('熄燈之後燈架還會留一下（熄燈那一瞬間才是開跑訊號）',
    app.includes('CD_LIGHTS_OUT') && app.includes('st.raceT < CD_LIGHTS_OUT'));
  ok('下一局開始前會把上一局的亮燈收乾淨', app.includes('setCountdownLights(0)'));
  ok('熄燈那一下不再叫一聲（go 事件自己有聲音）', app.includes('if (!go) G.audio.play'));

  /* 燈號序列：照著 C.COUNTDOWN 算一遍，時間點與數量都要對 */
  const Rules2 = require('../public/js/rules.js');
  const total = Rules2.C.COUNTDOWN;
  const step = total / CD_PODS;
  const litAt = t => Math.max(0, Math.min(CD_PODS, Math.floor(t / step) + 1));
  ok('倒數一開始就亮第一組', litAt(0) === 1);
  ok('每過一個 step 多亮一組',
    [0, 1, 2].every(i => litAt(i * step + 0.01) === i + 1));
  ok('倒數結束前三組全亮', litAt(total - 0.01) === CD_PODS);
  ok('最後一組亮完還有一段全紅（不然一亮就熄，反應不過來）', step >= 0.6, step.toFixed(2) + ' 秒');
}

/* ---------- 線上預測與校正 ---------- */
{
  const net = code('public/js/net.js');
  ok('本地那一份標成 predicted（圈數與完賽不自己算）',
    net.includes('state.predicted = true'));

  /* 快照是延遲抵達的，s.t 一定比本地小 —— 照抄會讓時間每 67ms 往回跳一次 */
  ok('時間只往前走，不倒退',
    net.includes('s.t > state.t') && net.includes('TIME_RESYNC'));

  /* 快照描述的是 lag 秒前的世界，不先往前推就會把本地該有的領先當成誤差 */
  ok('校正前先把快照按延遲往前推算',
    net.includes('state.t - s.t') && net.includes('LEAD_MAX') &&
    net.includes('Math.cos(sr.a) * sr.sp * lag'));
  ok('推算有上限（延遲太大不能一路推下去）', net.includes('LEAD_MAX'));
  ok('完賽與幽靈不往前推（他們不動了）', net.includes('!sr.fin && !sr.ghost'));
  ok('角度也跟著推（不然轉彎中的對手會一直落在彎外側）',
    net.includes('(sr.tv || 0) * lag'));

  /* 衝線那一刻不要硬拉：會把本地領先的那一段一次拉回來，看起來往後跳 */
  ok('硬對齊只留給差太多與幽靈，完賽的人用漸進校正',
    net.includes('err > SNAP_HARD || sr.ghost)') && !net.includes('|| sr.fin) {'));
}

/* ---------- 速度顯示 ---------- */
{
  ok('資訊欄有現在速度', ids.has('my-speed'));
  ok('單位寫 km/h', html.includes('<span id="my-speed">0</span><small>km/h</small>'));
  ok('速度跟計時排在同一區（sum-times）',
    html.indexOf('my-speed') > html.indexOf('sum-times') &&
    html.indexOf('my-speed') < html.indexOf('sum-item'));
  ok('速度用 Rules.kmh 換算，不在畫面端自己乘', app.includes('Rules.kmh(me.speed)'));
  /* 一秒六十次寫 textContent 會讓整欄重排（道具那一段踩過這個坑） */
  ok('整數沒變就不動 DOM', app.includes('hud.kmh !== kmh'));
  ok('hud 有 kmh 的初始值（不然第一幀不會寫進去）', app.includes('kmh: -1'));
  ok('衝線後歸零，不留殘值', app.includes("st.phase !== 'racing') ? 0"));
}

/* ---------- 小地圖的起終點旗 ---------- */
{
  const Tracks2 = require('../public/js/tracks.js');

  /* 把 buildMiniArt 整段挖出來跑：它畫在哪裡只能真的畫一次才知道。
   * 這裡餵一個假的 ctx，記下所有 fill 出來的點（旗子），
   * 路面中心線是 stroke、fillStyle 是空的，所以分得開。 */
  const src = code('public/js/app.js');
  const at = src.indexOf('function buildMiniArt()');
  let depth = 0, k = src.indexOf('{', at), end = k;
  for (; end < src.length; end++) {
    if (src[end] === '{') depth++;
    else if (src[end] === '}') { depth--; if (!depth) break; }
  }
  const body = src.slice(at, end + 1);
  ok('挖得出 buildMiniArt', body.length > 200 && body.includes('flag('));

  function flagsOf(track) {
    const pts = [];
    const ctx = {
      translate() {}, scale() {}, beginPath() {}, closePath() {}, stroke() {}, fill() {},
      moveTo(x, y) { pts.push([x, y, ctx.fillStyle]); },
      lineTo(x, y) { pts.push([x, y, ctx.fillStyle]); },
      fillStyle: '', strokeStyle: '', lineWidth: 0, lineJoin: '', lineCap: ''
    };
    const G = { track: track, theme: { road: '#aaa', roadEdge: '#fff' } };
    const Render = { makeCanvas: () => ({ getContext: () => ctx }) };
    const fn = new Function('G', 'root', 'return (' + body + ')')(G, { Render: Render });
    fn();
    return pts.filter(q => q[2]);          /* 只留旗子（有填色的） */
  }

  const misplaced = [], missing = [], stale = [];
  let flags = 0;
  for (const def of Tracks2.TRACKS) {
    const t = Tracks2.build(def);
    const pts = flagsOf(t);
    /* 該有幾面：環形一面（起終點同一個地方），衝刺兩面（頭跟尾） */
    const want = t.open
      ? [t.nodes[0], t.nodes[t.nodes.length - 1]]
      : [t.nodes[t.startNode]];
    for (const w of want) {
      flags++;
      let near = Infinity;
      for (const q of pts) near = Math.min(near, Math.hypot(q[0] - w.x, q[1] - w.y));
      if (near > w.w * 1.6) misplaced.push(def.id + ' 旗子離目標 ' + Math.round(near));
    }
    if (!pts.length) missing.push(def.id);
    /* 終點線本來畫在 nodes[0]，而起跑線其實在 startNode ——
     * 二十五張有十五張不一樣，最遠差 2576 單位。這條確保不會改回去。 */
    if (!t.open && t.startNode !== 0) {
      const a = t.nodes[0];
      const away = Math.hypot(a.x - t.nodes[t.startNode].x, a.y - t.nodes[t.startNode].y);
      if (away > 200) {
        let cnt = 0;
        for (const q of pts) if (Math.hypot(q[0] - a.x, q[1] - a.y) < a.w * 0.8) cnt++;
        if (cnt > 4) stale.push(def.id);
      }
    }
  }
  ok('每張賽道都有起終點旗', missing.length === 0, missing.join(', '));
  ok('起終點旗畫在正確的節點上（不是 nodes[0]）', misplaced.length === 0,
    misplaced.slice(0, 3).join('; '));
  ok('沒有賽道還把旗子畫在 nodes[0]', stale.length === 0, stale.slice(0, 3).join(', '));
  ok('驗到足夠多面旗子', flags >= 30, flags + ' 面');

  /* 衝刺賽道頭尾不相接，closePath 會憑空生出一段「終點連回起點」的路 */
  ok('衝刺賽道不 closePath（不然小地圖多一條不存在的路）',
    src.includes('if (!G.track.open) ctx.closePath();'));
  ok('衝刺賽道起點與終點都有標（看得出往哪邊跑）',
    src.includes("flag(nodes[0], '#2F8F4E')") &&
    src.includes('flag(nodes[nodes.length - 1])'));

  /* 一條純深灰粗線在 88～120 像素的小地圖上只是個黑點，
   * 而且純黑在夜間主題的路面上幾乎看不見 */
  ok('終點線是黑白格子旗，不是一條線',
    src.includes('COLS') && src.includes('#F7F9FB') && src.includes('(r + c) % 2'));
  ok('格子旗有外框（小尺寸下邊界才清楚）', src.includes("rgba(0,0,0,.45)"));
}

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
