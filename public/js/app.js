/* ===== app.js — 畫面流程與遊戲主迴圈 =====
 *
 * 規則在 rules.js，畫圖在 render.js，這支只負責把它們接起來：
 * 畫面切換、開一局、固定步長的模擬、每幀繪製、HUD、結算、設定。
 *
 * 模擬一律用固定步長 Rules.C.TICK（30Hz）推進，繪製才跟著 rAF；
 * 這樣單機與線上跑的是同一套時間軸，掉幀也不會讓物理跟著變。
 */
(function (root) {
  'use strict';

  const D = document;
  const $ = id => D.getElementById(id);
  const Rules = root.Rules, Tracks = root.Tracks, Items = root.Items;
  const Chars = root.Characters, TrackArt = root.TrackArt, RNG = root.RNG;

  /* ---------- 全域狀態 ---------- */

  const G = {
    settings: root.Store.load(),
    audio: root.Audio2.create(),
    input: null,
    mode: 'solo',              /* solo | online */
    state: null,               /* Rules 的 race state */
    track: null,
    theme: null,
    scenery: null,             /* 路邊的樹、石頭等場景物件 */
    miniArt: null,
    meId: 'me',
    trails: {},                /* 每隻毛毛蟲的軌跡（純畫面用） */
    cam: { x: 0, y: 0, z: 150, a: 0, h: 0, fov: 1, ready: false },
    boostVis: 0,
    camDist: 0,
    view: { w: 0, h: 0, dpr: 1, zoom: 1 },
    raf: 0, lastMs: 0, acc: 0,
    paused: false,
    finishedAt: 0,
    countShown: -1,
    lastResults: null,
    ctx: null,
    /* HUD 的上一次狀態：內容沒變就不要動 DOM */
    hud: { item: undefined, standings: '', rank: -1, lap: -1, note: null, frame: 0 }
  };

  /* ================================================================
   *  一、設定
   * ================================================================ */

  function applySettings() {
    const s = G.settings;
    D.body.classList.toggle('big-text', !!s.bigText);
    D.body.classList.toggle('reduce-motion', !!s.reduceMotion);
    G.audio.apply({ bgm: s.bgm, bgmVol: s.bgmVol, sfx: s.sfx, sfxVol: s.sfxVol });
    root.Store.save(s);
  }

  function buildSettingsModal() {
    for (const i of D.querySelectorAll('[data-icon]')) i.innerHTML = root.SvgUI.settingIcon(i.dataset.icon);
    $('btn-gear').innerHTML = root.SvgUI.gearIcon();
    $('settings-close').innerHTML = root.SvgUI.closeIcon();

    const s = G.settings;
    const bind = (id, key, kind) => {
      const el = $(id);
      if (!el) return;
      el.addEventListener('change', () => {
        if (kind === 'check') s[key] = el.checked;
        else if (kind === 'range') s[key] = Number(el.value) / 100;
        else if (kind === 'text') s[key] = el.value;
        else s[key] = Number(el.value);
        applySettings();
        G.audio.play('tap');
      });
    };
    bind('set-bgm', 'bgm', 'check');
    bind('set-bgm-vol', 'bgmVol', 'range');
    bind('set-sfx', 'sfx', 'check');
    bind('set-sfx-vol', 'sfxVol', 'range');
    bind('set-vibrate', 'vibrate', 'check');
    bind('set-sens', 'steerSens', 'select');
    bind('set-cam', 'camMode', 'text');
    bind('set-zoom', 'zoomLevel', 'select');
    bind('set-motion', 'reduceMotion', 'check');
    bind('set-color', 'colorAssist', 'check');
    bind('set-bigtext', 'bigText', 'check');
    bind('set-bad', 'allowBad', 'check');

    const modal = root.SvgUI.modal($('modal-settings'), $('btn-gear'));
    $('btn-gear').addEventListener('click', () => { unlockAudio(); refreshDataNote(); modal.open($('btn-gear')); });
    $('settings-close').addEventListener('click', modal.close);
    $('modal-settings').querySelector('[data-close]').addEventListener('click', modal.close);
    $('set-clear').addEventListener('click', () => {
      G.settings = root.Store.clearRecords(G.settings);
      refreshDataNote(); refreshBest();
    });
    $('set-reset').addEventListener('click', () => {
      G.settings = root.Store.resetSettings(G.settings);
      applySettings();
      buildSettingsValues();
      refreshDataNote();
    });
    G.settingsModal = modal;
  }

  function buildSettingsValues() {
    const s = G.settings;
    $('set-bgm').checked = s.bgm; $('set-sfx').checked = s.sfx;
    $('set-bgm-vol').value = Math.round(s.bgmVol * 100);
    $('set-sfx-vol').value = Math.round(s.sfxVol * 100);
    $('set-vibrate').checked = s.vibrate;
    $('set-sens').value = String(s.steerSens);
    $('set-cam').value = s.camMode;
    $('set-zoom').value = String(s.zoomLevel);
    $('set-motion').checked = s.reduceMotion;
    $('set-color').checked = s.colorAssist;
    $('set-bigtext').checked = s.bigText;
    $('set-bad').checked = s.allowBad;
  }

  function refreshDataNote() {
    const s = G.settings;
    let n = 0;
    for (const t in s.records) n += Object.keys(s.records[t]).length;
    $('set-data-note').textContent = '玩過 ' + (s.plays || 0) + ' 局，存了 ' + n + ' 筆最佳成績。這些只留在這台裝置上。';
  }

  function unlockAudio() {
    G.audio.unlock();
    G.audio.apply({ bgm: G.settings.bgm, bgmVol: G.settings.bgmVol, sfx: G.settings.sfx, sfxVol: G.settings.sfxVol });
  }

  function buzz(ms) {
    if (!G.settings.vibrate || !root.navigator || !root.navigator.vibrate) return;
    try { root.navigator.vibrate(ms); } catch (e) { /* 忽略 */ }
  }

  /* ================================================================
   *  二、畫面切換
   * ================================================================ */

  const SCREENS = ['home', 'setup', 'help', 'lobby', 'room', 'race', 'result'];

  function show(name) {
    for (const s of SCREENS) {
      const el = $('screen-' + s);
      if (el) el.hidden = (s !== name);
    }
    D.body.dataset.screen = name;
    /* 「回遊戲大廳」只在首頁出現；其他畫面左上角已經有自己的返回鍵 */
    const lobbyLink = $('lobby-home-link');
    if (lobbyLink) lobbyLink.hidden = (name !== 'home');
    if (name !== 'race') stopLoop();
    if (name === 'home' || name === 'setup') G.audio.setTheme(G.settings.lastTrack || 'garden');
  }

  /* ================================================================
   *  三、首頁與選單
   * ================================================================ */

  function buildHomeArt() {
    const picks = ['lime', 'berry', 'sky'].map(id => root.Render.wormSvg(Chars.get(id), 120));
    $('home-art').innerHTML =
      '<svg viewBox="0 0 320 190" aria-label="三隻毛毛蟲在賽道上">' +
      '<defs><linearGradient id="ha-sky" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#F3FBE4"/><stop offset="100%" stop-color="#CFEFAE"/></linearGradient></defs>' +
      '<rect width="320" height="190" rx="18" fill="url(#ha-sky)"/>' +
      '<path d="M-10 150q80-40 170-18t170-6v64H-10z" fill="#D9A86B"/>' +
      '<path d="M-10 150q80-40 170-18t170-6" fill="none" stroke="#F0E0BC" stroke-width="7"/>' +
      '<g transform="translate(14,62) scale(0.62)">' + picks[0] + '</g>' +
      '<g transform="translate(108,88) scale(0.5)">' + picks[1] + '</g>' +
      '<g transform="translate(188,70) scale(0.56)">' + picks[2] + '</g>' +
      '</svg>';
  }

  function buildCharGrid() {
    const grid = $('char-grid');
    grid.innerHTML = '';
    for (const c of Chars.CHARACTERS) {
      const b = D.createElement('button');
      b.type = 'button';
      b.className = 'char-card';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(c.id === G.settings.char));
      b.innerHTML = root.Render.wormSvg(c, 84) + '<b>' + c.name + '</b>';
      b.addEventListener('click', () => {
        G.settings.char = c.id;
        root.Store.save(G.settings);
        for (const n of grid.children) n.setAttribute('aria-checked', 'false');
        b.setAttribute('aria-checked', 'true');
        G.audio.play('tap');
      });
      grid.appendChild(b);
    }
  }

  /** 賽道小縮圖：把中心線畫成一條粗線，一眼看得出形狀 */
  function trackThumb(def) {
    const track = Tracks.build(def);
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    for (const nd of track.nodes) {
      minX = Math.min(minX, nd.x); maxX = Math.max(maxX, nd.x);
      minY = Math.min(minY, nd.y); maxY = Math.max(maxY, nd.y);
    }
    const w = maxX - minX, h = maxY - minY;
    const pts = track.nodes.map(nd => (nd.x - minX).toFixed(0) + ',' + (nd.y - minY).toFixed(0)).join(' ');
    const theme = TrackArt.get(def.theme);
    const lw = Math.max(w, h) * 0.075;
    const pad = lw * 0.9;
    return '<svg class="mini-track" viewBox="' + (-pad) + ' ' + (-pad) + ' ' + (w + pad * 2) + ' ' + (h + pad * 2) + '" preserveAspectRatio="xMidYMid meet" aria-hidden="true">' +
      '<polygon points="' + pts + '" fill="none" stroke="' + theme.roadEdge + '" stroke-width="' + lw + '" stroke-linejoin="round"/>' +
      '<polygon points="' + pts + '" fill="none" stroke="' + theme.road + '" stroke-width="' + (lw * 0.68) + '" stroke-linejoin="round"/>' +
      '</svg>';
  }

  function buildTrackGrid() {
    const grid = $('track-grid');
    grid.innerHTML = '';
    const randomPreview = Tracks.randomDef('preview');
    const defs = Tracks.TRACKS.concat([Object.assign({}, randomPreview, {
      name: '隨機賽道', desc: '每一局都不一樣，用種子現生出來的新賽道。', stars: 3, laps: 3
    })]);
    for (const def of defs) {
      const b = D.createElement('button');
      b.type = 'button';
      b.className = 'track-card';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(def.id === G.settings.lastTrack));
      let stars = '';
      for (let i = 1; i <= 4; i++) stars += root.SvgUI.starIcon(i <= (def.stars || 1));
      b.innerHTML = trackThumb(def) +
        '<b>' + def.name + '</b>' +
        '<span class="t-meta">' + stars + '<span>' + (def.laps || 3) + ' 圈</span></span>' +
        '<span class="t-desc">' + def.desc + '</span>';
      b.addEventListener('click', () => {
        G.settings.lastTrack = def.id;
        root.Store.save(G.settings);
        for (const n of grid.children) n.setAttribute('aria-checked', 'false');
        b.setAttribute('aria-checked', 'true');
        G.audio.setTheme(def.theme);
        refreshBest();
        G.audio.play('tap');
      });
      grid.appendChild(b);
    }
  }

  function buildDiffRow() {
    const row = $('diff-row');
    row.innerHTML = '';
    for (const id of Rules.DIFFICULTY_LIST) {
      const d = Rules.DIFFICULTY[id];
      const b = D.createElement('button');
      b.type = 'button';
      b.className = 'diff-btn';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(id === G.settings.difficulty));
      b.textContent = d.name;
      b.addEventListener('click', () => {
        G.settings.difficulty = id;
        root.Store.save(G.settings);
        for (const n of row.children) n.setAttribute('aria-checked', 'false');
        b.setAttribute('aria-checked', 'true');
        refreshDiffHint(); refreshBest();
        G.audio.play('tap');
      });
      row.appendChild(b);
    }
    refreshDiffHint();
  }

  const DIFF_HINT = {
    baby: '幼幼班：電腦跑得慢、不會丟壞道具，你落後太多時還會放慢等你。蠕動衝刺也比較好按出來（三格就衝）。',
    easy: '簡單：電腦會走賽道，但常常過彎過頭，道具也用得晚。',
    normal: '普通：電腦會走理想線、順路吃加速帶，道具用在該用的時候。',
    hard: '困難：電腦幾乎不出錯，會抄內線、走捷徑、閃開黏液，長直線一定扭出蠕動衝刺。'
  };
  function refreshDiffHint() { $('diff-hint').textContent = DIFF_HINT[G.settings.difficulty] || ''; }

  function refreshBest() {
    const b = root.Store.best(G.settings, G.settings.lastTrack, G.settings.difficulty);
    $('setup-best').textContent = b && b.time
      ? '你在這裡的最佳成績：' + b.time.toFixed(2) + ' 秒' + (b.lap ? '（最快單圈 ' + b.lap.toFixed(2) + ' 秒）' : '')
      : '這張賽道還沒有紀錄，跑一局看看。';
  }

  function buildHelp() {
    const keyRow =
      '<div class="help-keys">' +
      '<span class="help-key">' + root.SvgUI.arrowIcon(-1) + '左轉（← 或 A）</span>' +
      '<span class="help-key">' + root.SvgUI.arrowIcon(1) + '右轉（→ 或 D）</span>' +
      '<span class="help-key">' + root.SvgUI.arrowIcon(1, 'up') + '前進（↑ 或 W）</span>' +
      '<span class="help-key">' + root.SvgUI.arrowIcon(1, 'down') + '煞車倒退（↓ 或 S）</span>' +
      '<span class="help-key">' + root.SvgUI.itemIcon('juice', 24) + '用道具（空白鍵）</span>' +
      '</div>';
    let itemHtml = '';
    for (const id of Items.ALL) {
      const it = Items.ITEMS[id];
      itemHtml += '<div class="item-row' + (it.kind === 'bad' ? ' bad' : '') + '">' +
        root.SvgUI.itemIcon(id, 40) + '<div><b>' + it.name + '</b><span>' + it.hint + '</span></div></div>';
    }
    $('help-body').innerHTML =
      '<section class="panel"><h3>毛毛蟲會自己往前</h3>' +
      '<p>手機和平板上毛毛蟲會自己往前爬，你只要左下角左轉、右下角右轉，中間下方那顆用道具。</p>' +
      '<p>電腦上油門在你手上：<b>按住 ↑ 才會前進</b>，放開會自己滑行停下來；' +
      '↓ 是煞車、停住之後慢慢倒退，← → 轉向，空白鍵用道具。</p>' + keyRow +
      '<p>畫面是追尾視角，鏡頭固定在自己身上，毛毛蟲永遠在畫面正中央，地平線永遠是水平的。' +
      '覺得會暈的話，右上角設定裡可以把「鏡頭遠近」調遠一點；' +
      '鏡頭預設在毛毛蟲正後方、看著牠車頭指的方向，跟一般賽車遊戲一樣 —— ' +
      '直線就是直的，彎道才跟著轉。覺得會暈的話，設定裡可以把「鏡頭遠近」調遠一點，' +
      '或是把「鏡頭跟隨」換成「跟賽道方向」。</p></section>' +

      '<section class="panel"><h3>蠕動衝刺是這個遊戲的關鍵</h3>' +
      '<p>真的毛毛蟲是靠身體左右波動前進的，這裡也一樣。左右<b>交替</b>按，而且每次換邊的間隔抓在<b>大約半秒</b>，' +
      '資訊欄的蠕動槽就會一格一格亮起來。亮滿四格，毛毛蟲會自動衝刺 1.2 秒，速度多 45%。</p>' +
      '<p>亂按沒有用 —— 換邊太快（不到 0.12 秒）會直接歸零，太慢（超過 0.55 秒）也會洩氣。</p>' +
      '<p>扭身體會讓你偏離走線，所以長直線盡量扭，快進彎時要收手。這就是這個遊戲的取捨。</p></section>' +

      '<section class="panel"><h3>賽道上有什麼</h3>' +
      '<p><b>土色跑道</b>跑最快。<b>草地</b>還能走，但只剩六成半的速度。<b>深色泥巴</b>更慢，剩四成半。</p>' +
      '<p><b>發亮的露珠</b>是加速帶，踩過去會快 1.5 秒。<b>發光的葉子</b>是道具，撞上去就抽一個。</p>' +
      '<p><b>石頭和樹幹</b>撞到會彈開，速度只剩三成半，所以能閃就閃。</p>' +
      '<p>先跑完指定圈數的人贏。倒著跑不會多算圈數，每一圈都要照順序經過賽道上的檢查點。</p></section>' +

      '<section class="panel"><h3>六種道具</h3>' + itemHtml +
      '<p class="hint">右上角設定可以關掉負面道具；幼幼班本來就不會抽到。</p></section>';
  }

  /* ================================================================
   *  四、開一局
   * ================================================================ */

  function makeRacers(opt) {
    const list = [];
    const name = (G.settings.nickname || '').trim() || root.Nicknames.random();
    list.push({ id: 'me', name, char: G.settings.char, kind: 'human', difficulty: G.settings.difficulty });
    const pool = Chars.CHARACTERS.filter(c => c.id !== G.settings.char);
    for (let i = 0; i < opt.aiCount; i++) {
      list.push({
        id: 'ai' + i,
        name: root.Nicknames.random() + '（' + Rules.DIFFICULTY[opt.difficulty].name + '）',
        char: pool[i % pool.length].id, kind: 'ai', difficulty: opt.difficulty
      });
    }
    return list;
  }

  /** 開始一局。線上模式由 online.js 呼叫並傳 racers 與 seed。 */
  function startRace(opt) {
    opt = opt || {};
    G.mode = opt.mode || 'solo';
    const trackId = opt.trackId || G.settings.lastTrack || 'garden';
    const seed = opt.seed || RNG.newSeed();
    G.track = Tracks.get(trackId, seed);
    G.theme = TrackArt.get(G.track.theme);
    G.meId = opt.meId || 'me';

    const racers = opt.racers || makeRacers({ aiCount: G.settings.aiCount, difficulty: G.settings.difficulty });

    G.state = Rules.createRace({
      track: G.track,
      racers,
      laps: opt.laps || G.track.laps,
      seed,
      allowBad: opt.allowBad !== undefined ? opt.allowBad : G.settings.allowBad
    });

    /* 路邊的樹、蘑菇、花、石頭：開局用 seed 撒一次，之後每幀只是投影它們 */
    G.scenery = root.Render.buildScenery(G.track, RNG.create(seed + ':art'));
    G.miniArt = buildMiniArt();

    /* 軌跡初始化：往後補一段，開局就有身體，不會縮成一坨 */
    G.trails = {};
    G.bannerKey = '';
    G.camVel = null;
    hideRaceResult();
    { const rp = $('room-result'); if (rp) rp.hidden = true; }
    if (G.resultTimer) { root.clearTimeout(G.resultTimer); G.resultTimer = 0; }
    $('finish-banner').hidden = true;
    for (const r of G.state.racers) {
      const hist = [];
      for (let i = 0; i < 40; i++) {
        hist.push({ x: r.x - Math.cos(r.angle) * i * 2.2, y: r.y - Math.sin(r.angle) * i * 2.2 });
      }
      G.trails[r.id] = hist;
    }

    const me = myRacer();
    G.cam = { x: me.x, y: me.y, z: camView().height, a: me.angle, h: me.angle, fov: 1, ready: true };
    G.boostVis = 0;
    G.camDist = 0;
    resize();
    updateCamera(me, 1 / 60, true);
    G.paused = false;
    G.finishedAt = 0;
    G.lastResults = null;
    G.countShown = -1;

    G.hud = { item: undefined, standings: '', rank: -1, lap: -1, note: null, frame: 0 };
    $('chat-dock').hidden = (G.mode !== 'online');
    $('my-rank-total').textContent = '/' + G.state.racers.length;
    /* 衝刺賽道沒有圈數，圈數欄改成走完多少路 */
    const sprint = !!(G.track && G.track.open);
    $('my-lap-total').textContent = sprint ? '%' : ('/' + G.state.laps);
    $('my-lap-unit').textContent = sprint ? '' : ' 圈';
    $('lap-time-label').textContent = sprint ? '總時間' : '本圈';
    $('toast-wrap').innerHTML = '';

    show('race');
    resize();
    unlockAudio();
    G.audio.setTheme(G.track.theme);
    if (G.settings.bgm) G.audio.startBgm(G.track.theme);
    maybeRotateTip();

    G.lastMs = 0; G.acc = 0;
    startLoop();
    return G.state;
  }

  function myRacer() {
    return G.state.racers.find(r => r.id === G.meId) || G.state.racers[0];
  }

  function maybeRotateTip() {
    const portrait = root.innerHeight > root.innerWidth;
    const small = Math.min(root.innerWidth, root.innerHeight) < 560;
    $('rotate-tip').hidden = !(portrait && small && !G.settings.seenRotateTip && D.body.dataset.screen === 'race');
  }
  function hideRotateTip() {
    $('rotate-tip').hidden = true;
    G.settings.seenRotateTip = true;
    root.Store.save(G.settings);
  }

  /* ================================================================
   *  五、主迴圈
   * ================================================================ */

  function startLoop() {
    stopLoop();
    G.raf = root.requestAnimationFrame(frame);
  }
  function stopLoop() {
    if (G.raf) root.cancelAnimationFrame(G.raf);
    G.raf = 0;
  }

  /* 自動畫質：量最近的畫面時間，跟不上就把「好看但不影響玩法」的東西關掉
   * （地面顆粒、太陽光暈、雲、速度線、遠處的裝飾）。
   * 用兩個門檻做遲滯，才不會在邊界上一直開開關關。 */
  function updateQuality(dt) {
    const ms = Math.min(120, dt * 1000);
    G.frameMs = G.frameMs ? G.frameMs + (ms - G.frameMs) * 0.08 : ms;
    if (G.settings.reduceMotion) { G.lite = true; return; }
    if (!G.lite && G.frameMs > 23) G.lite = true;        /* 低於約 43fps 就降 */
    else if (G.lite && G.frameMs < 16.5) G.lite = false; /* 回到約 60fps 才升 */
  }

  /* 分頁切走時 requestAnimationFrame 會被瀏覽器停掉，比賽就等於被凍住了 ——
   * 線上是伺服器在跑，回來會發現自己被丟在後面；單機卻整場停在那裡。
   * 所以單機改成「以真實時間為準」：切走多久就補跑多久。
   *
   *   1. 用 performance.now() 算真實經過的時間，不是 rAF 的時間戳
   *   2. 補跑有預算（一幀最多 CATCHUP_MAX 秒），剩下的留在 acc 下一幀繼續補，
   *      免得離開太久時一次跑幾千個 tick 把瀏覽器卡死
   *   3. 另外掛一個 setInterval：分頁隱藏時 rAF 完全不跑，靠它推進
   *      （背景 timer 會被限制到一秒一次，但一次補一秒的量，結果一樣）
   */
  const CATCHUP_MAX = 2.5;      /* 一次最多補跑幾秒的模擬 */
  const BACKLOG_MAX = 90;       /* 累積超過這麼久就不補了，當作那一段沒發生 */

  function advance(nowMs) {
    if (!G.state) return 0;
    if (!G.lastMs) G.lastMs = nowMs;
    let dt = (nowMs - G.lastMs) / 1000;
    G.lastMs = nowMs;
    if (dt < 0) dt = 0;
    if (dt > BACKLOG_MAX) dt = BACKLOG_MAX;

    if (G.mode === 'online') {
      if (root.Online) root.Online.tick(Math.min(dt, 0.25));
      return dt;
    }
    if (G.paused) return dt;

    G.acc += dt;
    if (G.acc > BACKLOG_MAX) G.acc = BACKLOG_MAX;
    const budget = Math.ceil(CATCHUP_MAX / Rules.C.TICK);
    let guard = 0;
    while (G.acc >= Rules.C.TICK && guard++ < budget) {
      simTick();
      G.acc -= Rules.C.TICK;
    }
    return dt;
  }

  function frame(ms) {
    G.raf = root.requestAnimationFrame(frame);
    if (!G.state) return;
    const now = (root.performance && root.performance.now) ? root.performance.now() : Date.now();
    const dt = advance(now);
    G.frameDt = Math.min(0.25, dt);
    updateQuality(G.frameDt);

    updateTrails();
    draw();
    updateHud();
  }

  /** 分頁被藏起來時 rAF 不跑，靠這支把模擬推下去（不畫，只算） */
  function hiddenTick() {
    if (!G.state || G.mode === 'online') return;
    if (!D.hidden) return;
    const now = (root.performance && root.performance.now) ? root.performance.now() : Date.now();
    advance(now);
  }

  /* 轉向靈敏度：慢一點＝每三個 tick 少吃一次轉向，快一點＝多給一次微調。
   * 直接改角速度會讓單機與線上的物理不一致，所以改在「輸入」這一層做。 */
  let sensTick = 0;
  function applySens(steer) {
    if (!steer) return 0;
    sensTick++;
    if (G.settings.steerSens === 0 && sensTick % 4 === 0) return 0;
    return steer;
  }

  function simTick() {
    const st = G.state;
    const inputs = root.AI.inputsFor(st);
    const me = myRacer();
    if (me && !me.finished) {
      const raw = G.input.read();
      inputs[me.id] = { steer: applySens(raw.steer), gas: raw.gas || 0, man: raw.man || 0, use: raw.use };
    }
    Rules.step(st, inputs);
    handleEvents(st.events);
    if (st.phase === 'finished' && !G.finishedAt) {
      G.finishedAt = st.raceT || 0.01;
      endRace();
    }
  }

  /** 線上模式推進狀態後也呼叫這裡，共用同一套事件處理 */
  function handleEvents(events) {
    const meId = G.meId;
    for (const e of events) {
      if (e.type === 'go') { G.audio.play('go'); toast('開跑！'); continue; }
      if (e.type === 'over') continue;
      if (e.id !== meId) continue;

      if (e.type === 'wiggle') { G.audio.play('wiggle'); buzz(18); }
      else if (e.type === 'pad') { G.audio.play('pad'); }
      else if (e.type === 'pick') { G.audio.play('pick'); }
      else if (e.type === 'wall') { G.audio.play('wall'); buzz(35); }
      else if (e.type === 'bump') { G.audio.play('bump'); }
      else if (e.type === 'goo') { G.audio.play('goo'); toast('被黏住了！'); buzz(40); }
      else if (e.type === 'hit') { G.audio.play('hit'); toast('中招了！'); buzz(40); }
      else if (e.type === 'blocked') { G.audio.play('blocked'); toast('泡泡幫你擋下來了'); }
      else if (e.type === 'dodge') { toast('飄過去了！'); }
      else if (e.type === 'lap') { G.audio.play('lap'); toast('第 ' + Math.min(G.state.laps, e.lap + 1) + ' 圈'); }
      else if (e.type === 'full') { if (e.id === G.meId) toast('手上已經有道具了'); }
      else if (e.type === 'finish') { G.audio.play('finish'); }
    }
  }

  function toast(text) {
    const wrap = $('toast-wrap');
    const el = D.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    wrap.appendChild(el);
    while (wrap.children.length > 3) wrap.removeChild(wrap.firstChild);
    root.setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 1400);
  }

  function updateTrails() {
    for (const r of G.state.racers) {
      const hist = G.trails[r.id] || (G.trails[r.id] = []);
      const last = hist[0];
      if (!last || Math.hypot(r.x - last.x, r.y - last.y) > 1.2) {
        hist.unshift({ x: r.x, y: r.y });
        if (hist.length > 90) hist.length = 90;
      }
    }
  }

  /* ================================================================
   *  六、繪製（真透視的追尾視角）
   *
   *  鏡頭在毛毛蟲後上方，地平線永遠水平。所有東西都交給 render.js 的
   *  投影器換算，地面的東西（賽道、泥巴、黏液）先依距離由遠到近畫，
   *  再畫立起來的東西（樹、石頭、道具葉、毛毛蟲），一樣由遠到近。
   * ================================================================ */

  /* 三段視野：鏡頭拉多遠、架多高。拉遠看得到更多前方彎道，也比較不暈。 */
  const CAM_VIEWS = [
    { back: 124, height: 54 },    /* 近一點：貼著毛毛蟲，最有速度感 */
    { back: 158, height: 72 },    /* 普通：看得到毛毛蟲前面那一段路 */
    { back: 212, height: 104 }    /* 遠一點：看得到更多前方彎道 */
  ];
  /* 鏡頭偏航要跟誰：
   *   track  跟前方賽道的方向（預設）—— 蠕動的左右擺完全不會傳到畫面
   *   chase  跟毛毛蟲的車頭 —— 比較跟手，但扭的時候畫面會跟著晃
   */
  const CAM_YAW_LERP = { track: 0.16, chase: 0.30 };
  const CAM_MAX_RATE = 1.7;      /* 每秒最多轉幾弧度，突然的方向變化才不會甩鏡頭 */
  const CAM_POS_LERP = 0.10;     /* 位置的跟隨速度，慢一點才不會被蠕動帶著抖 */

  function camView() { return CAM_VIEWS[G.settings.zoomLevel] || CAM_VIEWS[1]; }

  function resize() {
    const cv = $('stage');
    const box = cv.getBoundingClientRect();
    const dpr = Math.min(root.devicePixelRatio || 1, 2);
    G.view.w = Math.max(1, Math.round(box.width));
    G.view.h = Math.max(1, Math.round(box.height));
    G.view.dpr = dpr;
    cv.width = Math.round(G.view.w * dpr);
    cv.height = Math.round(G.view.h * dpr);
    G.ctx = cv.getContext('2d');
    maybeRotateTip();
  }

  /**
   * 鏡頭要轉到哪個角度。
   * track 模式看的是「前方賽道的方向」而不是車頭 —— 賽道方向不會因為蠕動而抖，
   * 但過彎時還是會順順地轉，而且毛毛蟲本來就大致順著賽道，操作仍然直覺。
   */
  /**
   * chase 模式的鏡頭軸線 ——「跟一般賽車一樣」的關鍵在這裡。
   *
   * 用瞬時車頭（me.angle）不行：蠕動衝刺就是靠左右交替扭出來的，
   * 車頭本來就在以大約 2Hz 來回擺，鏡頭跟著它走，直線上畫面就一直左右搖。
   *
   * 改成看「平滑過的行進方向」：把速度向量做指數平滑再取角度。
   * 平滑的是向量不是角度 —— 扭左跟扭右的橫向分量會自己抵銷掉，
   * 所以直線上算出來就是一條直的，過彎時才真的轉過去。
   * 時間常數約 0.55 秒，蓋掉一個完整的蠕動週期還有餘裕，彎道也還跟得上。
   */
  const CAM_VEL_LERP = 0.030;

  function chaseAxis(me, snapTo) {
    const hx = Math.cos(me.angle), hy = Math.sin(me.angle);
    const sp = Math.hypot(me.vx, me.vy);
    /* 速度太小、或正在倒車時，行進方向沒有意義（倒車還會讓鏡頭整個翻半圈），
     * 這兩種情況一律聽車頭的 */
    const useVel = sp > 25 && (me.vx * hx + me.vy * hy) > 0;
    const tx = useVel ? me.vx / sp : hx;
    const ty = useVel ? me.vy / sp : hy;

    let sm = G.camVel;
    if (!sm || snapTo) sm = G.camVel = { x: tx, y: ty };
    else {
      sm.x += (tx - sm.x) * CAM_VEL_LERP;
      sm.y += (ty - sm.y) * CAM_VEL_LERP;
      const len = Math.hypot(sm.x, sm.y);
      if (len > 1e-4) { sm.x /= len; sm.y /= len; }
      else { sm.x = tx; sm.y = ty; }
    }
    return Math.atan2(sm.y, sm.x);
  }

  function camTargetAngle(me, snapTo) {
    if (G.settings.camMode === 'chase') return chaseAxis(me, snapTo);
    const nodes = G.track.nodes, n = nodes.length;
    const ahead = Math.round((70 + me.speed * 0.4) / Tracks.NODE_STEP);
    const nd = nodes[Tracks.idx(G.track, me.node + ahead)];
    const a = Math.atan2(nd.ty, nd.tx);
    /* 倒著開或整個跑出賽道時，賽道方向可能跟車頭差很多，
     * 這時候硬轉過去會讓畫面翻半圈，改成聽車頭的。 */
    let diff = a - me.angle;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    return Math.abs(diff) > 1.9 ? me.angle : a;
  }

  function updateCamera(me, dt, snapTo) {
    const cv = camView();
    /* 速度越快鏡頭拉越遠，速度感才出得來 */
    const back = cv.back * (1 + Math.min(0.28, me.speed / 1600));

    /* 鏡頭的「軸線」：鏡頭沿著這個方向退到毛毛蟲後面，而且就看著這個方向。
     * 因為位置與偏航用的是同一個角度，毛毛蟲一定會落在畫面正中央 ——
     * 不管是過彎、被撞、還是倒退，視角都固定在自己身上。 */
    let axis = camTargetAngle(me, snapTo);
    let dh = axis - G.cam.h;
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    if (snapTo || G.settings.reduceMotion) {
      G.cam.h = axis;
    } else {
      const lerp = CAM_YAW_LERP[G.settings.camMode] || CAM_YAW_LERP.track;
      const want = dh * lerp;
      const cap = CAM_MAX_RATE * dt;
      G.cam.h += Math.abs(want) > cap ? Math.sign(want) * cap : want;
    }
    if (G.cam.h > Math.PI) G.cam.h -= Math.PI * 2;
    if (G.cam.h < -Math.PI) G.cam.h += Math.PI * 2;

    /* 位置直接算出來，不做額外的跟隨平滑 —— 平滑會讓鏡頭被拖在後面，
     * 毛毛蟲就忽大忽小，旁邊的對手還會比自己大顆。平滑做在 cam.h 上就夠了。 */
    G.cam.x = me.x - Math.cos(G.cam.h) * back;
    G.cam.y = me.y - Math.sin(G.cam.h) * back;
    G.cam.z += (cv.height - G.cam.z) * (snapTo ? 1 : 0.1);
    G.cam.a = G.cam.h;

    /* 視角寬窄：速度越快越廣，衝刺時再多開一點。
     * fov 是乘在 focal 上的倍率，越小視角越廣，東西從兩側刷過去越快。 */
    const st = G.state;
    const boosting = st && (st.t < me.wiggle.until || st.t < me.juiceUntil || st.t < me.padUntil);
    const fovWant = 1 - Math.min(0.07, me.speed / 4200) - (boosting ? 0.04 : 0);
    G.cam.fov = G.cam.fov + (fovWant - G.cam.fov) * (snapTo ? 1 : 0.08);
    G.boostVis = (G.boostVis || 0) + ((boosting ? 1 : 0) - (G.boostVis || 0)) * 0.12;

    /* 給地面條紋用：鏡頭累積跑過多遠，條紋才會往鏡頭捲過來 */
    G.camDist = (G.camDist || 0) + me.speed * dt;
  }

  function draw() {
    const ctx = G.ctx;
    if (!ctx || !G.state) return;
    const v = G.view, st = G.state, R = root.Render;
    const me = myRacer();
    const dt = Math.min(0.05, G.frameDt || 1 / 60);

    updateCamera(me, dt, false);
    const P = R.projector(v, G.cam);
    G.P = P;

    ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
    R.drawSky(ctx, P, G.theme, st.t, G.lite);
    R.drawGround(ctx, P, G.theme);
    R.drawGroundBands(ctx, P, G.theme, G.camDist || 0);
    if (!G.lite) R.drawGroundTexture(ctx, P, G.theme);

    /* 地面：賽道分段 ＋ 泥巴／加速帶／黏液／終點線，一起由遠到近畫 */
    const ground = [];
    R.trackFaces(P, G.track, me.node, G.theme, ground);
    R.trackDecals(P, G.track, G.theme, st, ground);
    ground.sort((a, b) => b.f - a.f);
    for (const g of ground) g.draw(ctx);

    R.drawFog(ctx, P, G.theme);

    /* 立起來的東西：場景物件、道具葉、毛毛蟲，一樣由遠到近。
     * 淡出的門檻跟著「自己離鏡頭多遠」走：比自己近三成以上的東西就開始淡掉。
     * 用固定距離的話，鏡頭被拖遠的那幾幀會讓旁邊的樹、葉子、對手整個爆開。 */
    const props = [];
    const meF = Math.max(60, P.pt(me.x, me.y, 0).f);
    const nearFade = f => Math.max(0, Math.min(1, (f - meF * 0.34) / (meF * 0.42)));
    for (const sc of G.scenery) {
      const p = P.pt(sc.x, sc.y, 0);
      /* 卡在鏡頭跟玩家中間的樹會被放大成擋住半個畫面的黑影，靠太近就淡出 */
      if (p.f > (G.lite ? R.FAR * 0.55 : R.FAR)) continue;
      if (p.x < -250 || p.x > v.w + 250) continue;
      const vis = nearFade(p.f);
      if (vis <= 0.03) continue;
      props.push({
        f: p.f,
        draw: c => {
          if (vis >= 1) { R.drawProp(c, sc, p.x, p.y, p.s, G.theme, st.t); return; }
          c.save(); c.globalAlpha = vis; R.drawProp(c, sc, p.x, p.y, p.s, G.theme, st.t); c.restore();
        }
      });
    }
    for (let i = 0; i < st.leaves.length; i++) {
      const leaf = st.leaves[i];
      if (st.t < leaf.readyAt) continue;
      const p = P.pt(leaf.x, leaf.y, 0);
      if (p.f < R.NEAR || p.f > R.FAR * 0.6) continue;
      const lv = nearFade(p.f);
      if (lv <= 0.03) continue;
      props.push({
        f: p.f,
        draw: c => {
          if (lv >= 1) { R.drawLeaf(c, p.x, p.y, p.s, st.t, i, p.f); return; }
          c.save(); c.globalAlpha = lv; R.drawLeaf(c, p.x, p.y, p.s, st.t, i, p.f); c.restore();
        }
      });
    }
    for (const r of st.racers) {
      const p = P.pt(r.x, r.y, 0);
      if (p.f < R.NEAR * 0.8 || p.f > R.FAR) continue;
      /* 卡在鏡頭跟自己中間的對手會被放到超大擋住畫面，靠太近就淡出 */
      /* 自己永遠最後畫、而且永遠不淡出 —— 視角是固定在自己身上的，
       * 不能因為有人貼在鏡頭與自己之間就把主角蓋掉。 */
      if (r.id === G.meId) continue;
      const near = nearFade(p.f);
      if (near <= 0.03) continue;
      props.push({
        f: p.f,
        draw: c => {
          if (near >= 1) { drawRacer(c, P, r); return; }
          c.save(); c.globalAlpha = near; drawRacer(c, P, r); c.restore();
        }
      });
    }
    props.sort((a, b) => b.f - a.f);
    for (const p of props) p.draw(ctx);
    if (P.pt(me.x, me.y, 0).f > R.NEAR * 0.8) drawRacer(ctx, P, me);

    /* 蜘蛛絲：兩隻毛毛蟲的頭之間拉一條線 */
    for (const w of st.webs) {
      const a = st.racers.find(r => r.id === w.from), b = st.racers.find(r => r.id === w.to);
      if (!a || !b) continue;
      const pa = P.pt(a.x, a.y, root.Render.HEAD_R), pb = P.pt(b.x, b.y, root.Render.HEAD_R);
      if (pa.f < R.NEAR || pb.f < R.NEAR) continue;
      ctx.strokeStyle = 'rgba(235,240,250,.9)';
      ctx.lineWidth = 2.4;
      ctx.setLineDash([7, 5]);
      ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
      ctx.setLineDash([]);
    }

    if (!G.lite) R.drawSpeedLines(ctx, P, G.boostVis || 0, st.t);

    drawNameplates(ctx, P);
    drawMini();
    drawCountdown();
    drawFinishBanner();
  }

  function drawRacer(ctx, P, r) {
    const ch = Chars.get(r.char);
    const st = G.state;
    /* 身體用「現在的位置與角度」直接排出來，不再沿著走過的軌跡取樣。
     * 取樣軌跡會讓後面幾節停在剛剛走過的地方，看起來就是一條殘影；
     * 改成從頭往後排，只用轉向量把身體彎一點，過彎時還是有弧度。 */
    const R0 = root.Render;
    const bend = Math.max(-0.30, Math.min(0.30, (r.turnVel || 0) * 0.16));
    const pts = [];
    let px = r.x, py = r.y, pa = r.angle;
    for (let i = 0; i <= R0.SEGS; i++) {
      pts.push({ x: px, y: py });
      pa -= bend;
      /* 地面上只退 SEG_RUN，剩下的距離由 render 用高度補 —— 身體是立起來的 */
      px -= Math.cos(pa) * R0.SEG_RUN;
      py -= Math.sin(pa) * R0.SEG_RUN;
    }

    /* 腳下光環：自己金色，別人用自己的深色。壓扁成橢圓才像貼在地上。 */
    const g0 = P.pt(r.x, r.y, 0);
    if (g0.f > root.Render.NEAR) {
      const rx = 22 * g0.s;
      ctx.save();
      ctx.globalAlpha = r.ghost ? 0.2 : 0.5;
      ctx.strokeStyle = (r.id === G.meId) ? '#FFD54A' : ch.bodyDark;
      ctx.lineWidth = Math.max(1, (r.id === G.meId ? 3.4 : 2) * g0.s);
      ctx.beginPath();
      ctx.ellipse(g0.x, g0.y, rx, rx * Math.min(0.9, G.cam.z / g0.f), 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    root.Render.drawWorm3D(ctx, P, ch, pts, {
      t: st.t,
      angle: r.angle,
      wiggle: st.t < r.wiggle.until,
      tiny: st.t < r.tinyUntil,
      shield: st.t < r.shieldUntil,
      hop: st.t < r.hopUntil,
      slow: st.t < r.slowUntil,
      ghost: r.ghost,
      isMe: r.id === G.meId,
      reduceMotion: G.settings.reduceMotion
    });
  }

  const SHAPE = { circle: 0, square: 1, heart: 2, drop: 3, star: 4, diamond: 5, leaf: 6, triangle: 7 };

  function drawNameplates(ctx, P) {
    const v = G.view;
    ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.font = '700 12px "Noto Sans TC", system-ui, sans-serif';
    /* 遠的先畫，近的蓋上去 */
    const list = G.state.racers.slice()
      .map(r => ({ r: r, p: P.pt(r.x, r.y, root.Render.HEAD_R * 2 + 16) }))
      .filter(o => o.p.f > root.Render.NEAR && o.p.f < 1400)
      .sort((a, b) => b.p.f - a.p.f);

    for (const o of list) {
      const r = o.r, p = o.p;
      if (p.x < -70 || p.x > v.w + 70 || p.y < -20 || p.y > v.h + 20) continue;
      /* 太遠就不標名字，畫面才不會一堆小字 */
      const fade = Math.max(0, Math.min(1, (1100 - p.f) / 500));
      if (fade <= 0.05) continue;
      const ch = Chars.get(r.char);
      const label = r.name + (r.ghost ? '（掉線）' : '');
      const w = ctx.measureText(label).width + (G.settings.colorAssist ? 24 : 14);
      ctx.globalAlpha = (r.ghost ? 0.4 : 0.92) * fade;
      ctx.fillStyle = 'rgba(255,253,243,.88)';
      roundRect(ctx, p.x - w / 2, p.y - 14, w, 18, 9);
      ctx.fill();
      if (G.settings.colorAssist) {
        ctx.fillStyle = ch.bodyDark;
        drawShape(ctx, p.x - w / 2 + 8, p.y - 5, 4.5, SHAPE[ch.shape] || 0);
      }
      ctx.fillStyle = (r.id === G.meId) ? '#2F6B0C' : '#4A4632';
      ctx.fillText(label, p.x + (G.settings.colorAssist ? 5 : 0), p.y);

      ctx.globalAlpha = 1;
    }
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawShape(ctx, x, y, r, kind) {
    ctx.beginPath();
    if (kind === 0) ctx.arc(x, y, r, 0, Math.PI * 2);
    else if (kind === 1) ctx.rect(x - r, y - r, r * 2, r * 2);
    else if (kind === 5) { ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath(); }
    else if (kind === 7 || kind === 3) { ctx.moveTo(x, y - r); ctx.lineTo(x + r, y + r); ctx.lineTo(x - r, y + r); ctx.closePath(); }
    else if (kind === 4) {
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + i * Math.PI / 5;
        const rad = i % 2 ? r * 0.45 : r;
        ctx[i ? 'lineTo' : 'moveTo'](x + Math.cos(a) * rad, y + Math.sin(a) * rad);
      }
      ctx.closePath();
    } else { ctx.ellipse(x, y, r, r * 0.75, 0, 0, Math.PI * 2); }
    ctx.fill();
  }

  /* ---------- 小地圖：追尾視角只看得到前面，需要一張俯視圖才知道整條賽道 ---------- */

  function buildMiniArt() {
    const size = 160;
    const b = G.track.bounds;
    const w = b.maxX - b.minX, h = b.maxY - b.minY;
    const s = size / Math.max(w, h);
    const cv = root.Render.makeCanvas(size, size);
    const ctx = cv.getContext('2d');
    const out = { canvas: cv, s: s, ox: b.minX, oy: b.minY, size: size, dx: (size - w * s) / 2, dy: (size - h * s) / 2 };
    if (!ctx) return out;
    ctx.translate(out.dx, out.dy);
    ctx.scale(s, s);
    ctx.translate(-b.minX, -b.minY);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.strokeStyle = G.theme.roadEdge; ctx.lineWidth = 62;
    ctx.beginPath();
    G.track.nodes.forEach((nd, i) => ctx[i ? 'lineTo' : 'moveTo'](nd.x, nd.y));
    ctx.closePath(); ctx.stroke();
    ctx.strokeStyle = G.theme.road; ctx.lineWidth = 44; ctx.stroke();
    const n0 = G.track.nodes[0];
    ctx.strokeStyle = '#2C2C2C'; ctx.lineWidth = 16;
    ctx.beginPath();
    ctx.moveTo(n0.x + n0.nx * n0.w, n0.y + n0.ny * n0.w);
    ctx.lineTo(n0.x - n0.nx * n0.w, n0.y - n0.ny * n0.w);
    ctx.stroke();
    return out;
  }

  function drawMini() {
    const cv = $('mini');
    const ctx = cv.getContext('2d');
    const m = G.miniArt;
    if (!ctx || !m) return;
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.save();
    ctx.scale(cv.width / m.size, cv.height / m.size);
    ctx.drawImage(m.canvas, 0, 0);
    ctx.translate(m.dx, m.dy);
    ctx.scale(m.s, m.s);
    ctx.translate(-m.ox, -m.oy);
    for (const r of G.state.racers) {
      const ch = Chars.get(r.char);
      ctx.globalAlpha = r.ghost ? 0.35 : 1;
      ctx.fillStyle = r.id === G.meId ? '#FFD54A' : ch.body;
      ctx.strokeStyle = r.id === G.meId ? '#8A5C08' : ch.bodyDark;
      ctx.lineWidth = 14;
      ctx.beginPath(); ctx.arc(r.x, r.y, r.id === G.meId ? 52 : 40, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  /* 自己衝過終點線的那一刻，畫面正中央大大地報名次。
   * 只報一次，之後就掛在那裡直到結算畫面接手（寬限時間裡還看得到別人在跑）。 */
  const FINISH_SUB = { 1: '第一名！', 2: '差一點點', 3: '還不錯', 4: '再來一次' };

  /**
   * 畫面上方那條大字。
   *
   * 10 秒收局倒數是「整場的」倒數，不是掛在某個人身上 ——
   * 已經衝線的、還在跑的、觀戰的，看到的是同一個數字。
   * 倒數期間一律顯示倒數，名次等這一局真的結束了才報，
   * 不然自己先衝線的話，名次會把大家都在看的倒數蓋掉。
   */
  function drawFinishBanner() {
    const st = G.state, me = myRacer();
    const el = $('finish-banner');
    if (!st || !me || st.phase === 'countdown') {
      if (!el.hidden) el.hidden = true;
      G.bannerKey = '';
      return;
    }

    const grace = st.graceEnd > 0 && st.phase === 'racing';

    let key = '', pos = '', sub = '', win = false, urgent = false, beep = false;
    if (grace) {
      const left = Math.max(0, Math.min(Rules.C.FINISH_GRACE, Math.ceil(st.graceEnd - st.raceT)));
      key = 'cd' + left;
      pos = String(left);
      sub = me.finished ? '秒後結束這一局' : '秒內衝過終點線！';
      urgent = left <= 3;
      beep = true;
    } else if (me.finished) {
      key = 'rank' + me.rank;
      pos = '第 ' + me.rank + ' 名';
      sub = FINISH_SUB[me.rank] || '完賽';
      win = me.rank === 1;
    } else {
      if (!el.hidden) el.hidden = true;
      G.bannerKey = '';
      return;
    }

    if (G.bannerKey === key) return;
    const wasHidden = el.hidden;
    G.bannerKey = key;
    $('fb-pos').textContent = pos;
    $('fb-sub').textContent = sub;
    el.classList.toggle('win', win);
    el.classList.toggle('urgent', urgent);
    el.hidden = false;
    /* 重播一次彈出動畫：倒數每一秒都彈一下，比較有壓迫感 */
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
    /* 倒數每一秒都有聲音，最後三秒換成比較急的那一顆 */
    if (beep) G.audio.play(urgent ? 'go' : 'count');
    else if (wasHidden) G.audio.play('finish');
  }

  function drawCountdown() {
    const st = G.state;
    const el = $('countdown');
    if (st.phase !== 'countdown') {
      if (!el.hidden) el.hidden = true;
      return;
    }
    const left = Math.ceil(Rules.C.COUNTDOWN - st.t);
    el.hidden = false;
    el.textContent = left > 0 ? String(left) : '開跑！';
    if (left !== G.countShown) {
      G.countShown = left;
      if (left > 0) G.audio.play('count');
    }
  }

  /* ================================================================
   *  七、HUD
   * ================================================================ */

  function updateHud() {
    const st = G.state, me = myRacer();
    if (!st || !me) return;
    const hud = G.hud;

    if (hud.rank !== me.rank) { hud.rank = me.rank; $('my-rank').textContent = String(me.rank); }
    const sprint = !!(G.track && G.track.open);
    const lapNow = sprint
      ? Math.min(100, Math.round(me.node / Math.max(1, G.track.nodes.length - 1) * 100))
      : Math.min(st.laps, me.lap + 1);
    if (hud.lap !== lapNow) { hud.lap = lapNow; $('my-lap').textContent = String(lapNow); }
    $('lap-time').textContent = (sprint
      ? Math.max(0, st.raceT)
      : (me.started ? Math.max(0, st.raceT - me.lapStart) : 0)).toFixed(2);

    /* 蠕動槽 */
    const gauge = $('wiggle-gauge');
    const need = (me.kind === 'human' && me.difficulty === 'baby') ? 3 : Rules.C.WIGGLE.NEED;
    const boosting = st.t < me.wiggle.until;
    if (gauge.children.length !== need) {
      gauge.innerHTML = '';
      for (let i = 0; i < need; i++) gauge.appendChild(D.createElement('i'));
    }
    gauge.classList.toggle('boost', boosting);
    for (let i = 0; i < need; i++) gauge.children[i].classList.toggle('on', boosting || i < me.wiggle.beats);

    /* 持有道具。
     * 這一段本來每一幀都重寫 innerHTML（而且裡面還有一整個 SVG）——
     * 一秒六十次重排，實測畫面上的道具名稱會疊出殘影。只在真的換道具時才動 DOM。 */
    if (me.item !== hud.item) {
      hud.item = me.item;
      const slot = $('sum-item');
      const itemBtn = $('btn-item');
      if (me.item) {
        slot.className = 'sum-item';
        slot.innerHTML = root.SvgUI.itemIcon(me.item, 30) +
          '<span>' + Items.ITEMS[me.item].name + '</span>';
        $('item-slot').innerHTML = root.SvgUI.itemIcon(me.item, 46);
        itemBtn.classList.add('has');
      } else {
        slot.className = 'sum-item empty';
        slot.textContent = '撞葉子拿道具';
        $('item-slot').innerHTML = '';
        itemBtn.classList.remove('has');
      }
    }

    /* 名次表：每四幀算一次就夠了，而且內容沒變就不要碰 DOM */
    if ((hud.frame++ & 3) === 0) {
      const sorted = st.racers.slice().sort((a, b) => a.rank - b.rank);
      let html = '';
      for (const r of sorted) {
        const ch = Chars.get(r.char);
        const gap = r.id === me.id ? '' :
          (r.finished ? r.finishTime.toFixed(1) + 's'
            : ((r.progress - me.progress) * Tracks.NODE_STEP / 100).toFixed(1) + 'm');
        html += '<li class="' + (r.id === me.id ? 'me' : '') + (r.ghost ? ' gone' : '') + '">' +
          '<span class="pos">' + r.rank + '</span>' +
          '<span class="dot" style="background:' + ch.body + '"></span>' +
          '<span class="nm">' + escapeHtml(r.name) + '</span>' +
          '<span class="gap">' + gap + '</span></li>';
      }
      if (html !== hud.standings) {
        hud.standings = html;
        $('standings').innerHTML = html;
      }
    }

    let note = '';
    if (me.ghost) note = '你掉線了，重新連上就能回到原位。';
    else if (me.finished) note = '你完賽了，等其他人跑完。';
    else if (G.mode === 'online' && root.Online) note = root.Online.statusText();
    if (hud.note !== note) { hud.note = note; $('sum-note').textContent = note; }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ================================================================
   *  八、結算
   * ================================================================ */

  function endRace() {
    const st = G.state;
    const results = Rules.results(st);
    G.lastResults = results;
    const me = results.find(r => r.id === G.meId) || results[0];

    let rec = { record: false, lapRecord: false };
    if (G.mode === 'solo') {
      rec = root.Store.record(G.settings, {
        track: G.track.random ? 'random' : G.track.id,
        difficulty: G.settings.difficulty,
        time: me.time, bestLap: me.bestLap, finished: me.finished, char: me.char,
        versus: { kind: 'ai', win: me.rank === 1 }
      });
    }

    const winner = results[0];
    $('winner').innerHTML = root.Render.wormSvg(Chars.get(winner.char), 140);
    $('result-title').textContent = me.rank === 1 ? '你贏了！' : (winner.name + ' 第一名');

    let html = '';
    for (const r of results) {
      html += '<li class="' + (r.id === G.meId ? 'me' : '') + '">' +
        '<span class="pos">' + r.rank + '</span>' +
        root.Render.wormSvg(Chars.get(r.char), 46) +
        '<span><span class="rname">' + escapeHtml(r.name) + '</span>' +
        '<span class="rlap">最快單圈 ' + (r.bestLap ? r.bestLap.toFixed(2) + 's' : '—') + '</span></span>' +
        '<span class="rtime">' + (r.finished ? r.time.toFixed(2) + 's' : '未完賽') + '</span></li>';
    }
    $('result-list').innerHTML = html;

    const s = me.stats;
    const statsHtml =
      '<li>蠕動衝刺<span>' + s.wiggleBoosts + ' 次</span></li>' +
      '<li>吃到加速帶<span>' + s.pads + ' 次</span></li>' +
      '<li>用掉道具<span>' + s.itemsUsed + ' 個（命中 ' + s.itemHits + '）</span></li>' +
      '<li>撞牆<span>' + s.hits + ' 次</span></li>' +
      '<li>跑到草地上<span>' + (s.offTrack / 30).toFixed(1) + ' 秒</span></li>' +
      (rec.record ? '<li><span class="record-badge">破紀錄</span><span>' + me.time.toFixed(2) + 's</span></li>' : '') +
      (rec.lapRecord ? '<li><span class="record-badge">最快單圈</span><span>' + me.bestLap.toFixed(2) + 's</span></li>' : '');
    $('result-stats').innerHTML = statsHtml;
    $('rr-stats-list').innerHTML = statsHtml;

    /* 線上時按鈕講清楚：主要動作是「留在房間」，要離開得自己按 */
    const online = (G.mode === 'online');
    $('again').textContent = online ? '回房間' : '再來一局';
    $('result-home').textContent = online ? '離開房間' : '回首頁';
    G.audio.stopBgm();
    /* 衝線之後先讓畫面停一秒：看得到自己的名次、終點線、還有誰沒跑完，
     * 再離開賽道畫面。收局的瞬間就換頁的話，那一格名次根本來不及看。 */
    if (G.resultTimer) root.clearTimeout(G.resultTimer);
    G.resultTimer = root.setTimeout(() => {
      G.resultTimer = 0;
      /* 單機與線上都不換場景：結算直接蓋在賽道畫面上，背景還是剛剛跑完的那一幕。
       * 線上按「再玩一場」就地準備，下一局開始時畫面接著跑，中間不會跳頁；
       * 單機的完整統計留在獨立頁，想看再按「看詳細統計」。 */
      showRaceResult(G.lastResults);
      if (G.mode === 'online' && root.Online) paintRoomResult(G.lastResults);
    }, 1000);
  }

  /** 線上結算浮層：蓋在賽道畫面上 */
  function showRaceResult(results) {
    const box = $('race-result');
    if (!box || !results || !results.length) return;
    const me = results.find(r => r.id === G.meId) || results[0];
    $('rr-title').textContent = me.rank === 1 ? '你贏了！' : (results[0].name + ' 第一名');
    let html = '';
    for (const r of results) {
      html += '<li class="' + (r.id === G.meId ? 'me' : '') + '">' +
        '<span class="pos">' + r.rank + '</span>' +
        root.Render.wormSvg(Chars.get(r.char), 30) +
        '<span><span class="rname">' + escapeHtml(r.name) + '</span></span>' +
        '<span class="rtime">' + (r.finished ? r.time.toFixed(2) + 's' : '未完賽') + '</span></li>';
    }
    $('rr-list').innerHTML = html;
    $('rr-hint').textContent = '';
    $('rr-again').disabled = false;

    /* 按鈕依模式換字：線上是房間那一套，單機是再跑一局那一套 */
    const online = (G.mode === 'online');
    $('rr-again').textContent = online ? '再玩一場' : '再來一局';
    $('rr-room').textContent = online ? '回房間' : '換賽道';
    $('rr-leave').textContent = online ? '離開房間' : '回首頁';
    $('rr-more').hidden = false;              /* 統計每個模式都看得到 */
    $('rr-more').textContent = '看詳細統計';
    $('rr-stats').hidden = true;
    box.hidden = false;
  }

  function hideRaceResult() {
    const box = $('race-result');
    if (box) box.hidden = true;
  }

  /** 把上一局的名次畫進房間的面板 */
  function paintRoomResult(results) {
    const panel = $('room-result');
    if (!panel) return;
    if (!results || !results.length) { panel.hidden = true; return; }
    let html = '';
    for (const r of results) {
      html += '<li class="' + (r.id === G.meId ? 'me' : '') + '">' +
        '<span class="pos">' + r.rank + '</span>' +
        root.Render.wormSvg(Chars.get(r.char), 30) +
        '<span><span class="rname">' + escapeHtml(r.name) + '</span></span>' +
        '<span class="rtime">' + (r.finished ? r.time.toFixed(2) + 's' : '未完賽') + '</span></li>';
    }
    $('room-result-list').innerHTML = html;
    panel.hidden = false;
  }

  /* ================================================================
   *  九、暫停
   * ================================================================ */

  function buildPause() {
    const modal = root.SvgUI.modal($('modal-pause'));
    G.pauseModal = modal;
    $('pause-resume').addEventListener('click', () => { G.paused = false; modal.close(); });
    $('pause-restart').addEventListener('click', () => {
      modal.close(); G.paused = false;
      if (G.mode === 'solo') startRace({ trackId: G.track.random ? 'random' : G.track.id });
    });
    $('pause-home').addEventListener('click', () => {
      modal.close(); G.paused = false; G.audio.stopBgm();
      if (G.mode === 'online' && root.Online) root.Online.leave();
      show('home');
    });
    $('modal-pause').querySelector('[data-close]').addEventListener('click', () => { G.paused = false; modal.close(); });
  }

  function togglePause() {
    if (D.body.dataset.screen !== 'race') return;
    if (G.mode === 'online') return;   /* 線上不能把別人一起暫停 */
    if (G.settingsModal && G.settingsModal.isOpen) return;
    G.paused = !G.paused;
    if (G.paused) G.pauseModal.open(); else G.pauseModal.close();
  }

  /* ================================================================
   *  十、啟動
   * ================================================================ */

  function wire() {
    $('go-solo').addEventListener('click', () => { unlockAudio(); show('setup'); refreshBest(); });
    $('go-online').addEventListener('click', () => {
      unlockAudio();
      if (root.Online) root.Online.open();
      else noteFlash('這個版本沒有線上模式');
    });
    $('go-help').addEventListener('click', () => { show('help'); G.settings.seenHelp = true; root.Store.save(G.settings); });
    $('setup-back').addEventListener('click', () => show('home'));
    $('help-back').addEventListener('click', () => show('home'));
    $('lobby-back').addEventListener('click', () => { if (root.Online) root.Online.leave(); show('home'); });
    $('room-back').addEventListener('click', () => { if (root.Online) root.Online.leaveRoom(); });

    $('ai-minus').addEventListener('click', () => setAiCount(G.settings.aiCount - 1));
    $('ai-plus').addEventListener('click', () => setAiCount(G.settings.aiCount + 1));
    $('nickname').value = G.settings.nickname || '';
    $('nickname').addEventListener('change', () => {
      G.settings.nickname = $('nickname').value.trim().slice(0, 8);
      root.Store.save(G.settings);
    });

    $('start-race').addEventListener('click', () => { unlockAudio(); startRace({ trackId: G.settings.lastTrack }); });
    $('again').addEventListener('click', () => {
      if (G.mode === 'online' && root.Online) { root.Online.backToRoom(); return; }
      startRace({ trackId: G.track && G.track.random ? 'random' : (G.track ? G.track.id : G.settings.lastTrack) });
    });
    $('result-home').addEventListener('click', () => {
      if (G.mode === 'online' && root.Online) root.Online.leave();
      show('home');
    });
    $('rr-again').addEventListener('click', () => {
      if (G.mode === 'online') {
        if (root.Online && root.Online.readyAgain()) {
          $('rr-again').disabled = true;
          $('rr-hint').textContent = '已經準備好了，等其他人。';
        }
        return;
      }
      hideRaceResult();
      startRace({ trackId: G.track && G.track.random ? 'random' : (G.track ? G.track.id : G.settings.lastTrack) });
    });
    $('rr-room').addEventListener('click', () => {
      hideRaceResult();
      if (G.mode === 'online') { if (root.Online) root.Online.backToRoom(); return; }
      show('setup');
    });
    $('rr-leave').addEventListener('click', () => {
      hideRaceResult();
      if (G.mode === 'online' && root.Online) root.Online.leave();
      show('home');
    });
    /* 詳細統計就地展開，不換畫面 */
    $('rr-more').addEventListener('click', () => {
      const st = $('rr-stats');
      st.hidden = !st.hidden;
      $('rr-more').textContent = st.hidden ? '看詳細統計' : '收起統計';
    });
    const moreBtn = $('room-result-more');
    if (moreBtn) moreBtn.addEventListener('click', () => show('result'));
    $('rotate-ok').addEventListener('click', hideRotateTip);
    $('sum-toggle').addEventListener('click', () => {
      const body = $('sum-body');
      body.hidden = !body.hidden;
      $('sum-toggle').setAttribute('aria-expanded', String(!body.hidden));
    });

    /* 分頁隱藏時 rAF 停擺，用 timer 續命；回到前景再補一次，畫面才不會跳 */
    root.setInterval(hiddenTick, 250);
    D.addEventListener('visibilitychange', () => {
      if (!D.hidden && G.state) {
        const now = (root.performance && root.performance.now) ? root.performance.now() : Date.now();
        advance(now);
      }
    });

    root.addEventListener('resize', () => { if (D.body.dataset.screen === 'race') resize(); maybeRotateTip(); });
    root.addEventListener('orientationchange', () => root.setTimeout(() => {
      if (D.body.dataset.screen === 'race') resize();
      maybeRotateTip();
    }, 250));
    /* 第一次任何點擊都拿來解鎖音訊（瀏覽器規定要有使用者手勢） */
    D.addEventListener('pointerdown', unlockAudio, { once: true });
  }

  function setAiCount(n) {
    G.settings.aiCount = Math.max(0, Math.min(5, n));
    $('ai-count').textContent = String(G.settings.aiCount);
    root.Store.save(G.settings);
    G.audio.play('tap');
  }

  function noteFlash(text) {
    const note = $('build-note');
    note.textContent = text;
    root.setTimeout(() => { note.textContent = buildNote(); }, 2600);
  }

  function buildNote() {
    const c = root.Config;
    if (!c || c.status === 'unset') return '單機模式（沒有設定遊戲伺服器）';
    if (c.status === 'invalid') return '伺服器位置設定有問題：' + c.error;
    return '';
  }

  function boot() {
    applySettings();
    buildSettingsModal();
    buildSettingsValues();
    buildPause();
    buildHomeArt();
    buildCharGrid();
    buildTrackGrid();
    buildDiffRow();
    buildHelp();
    refreshBest();
    refreshDataNote();
    $('ai-count').textContent = String(G.settings.aiCount);
    $('build-note').textContent = buildNote();

    G.input = root.Input.create({ onPause: togglePause });
    G.input.attach({ left: $('btn-left'), right: $('btn-right'), item: $('btn-item') });
    $('btn-left').innerHTML = root.SvgUI.arrowIcon(-1);
    $('btn-right').innerHTML = root.SvgUI.arrowIcon(1);

    wire();
    show('home');

    /* 帶著邀請連結進來就直接去線上 */
    try {
      const params = new URLSearchParams(root.location.search);
      if (params.get('room') && root.Online) root.Online.open(params.get('room'), params.get('t'));
    } catch (e) { /* 忽略 */ }
  }

  /* 給 online.js 用的介面 */
  root.App = {
    G, show, startRace, toast, handleEvents, updateHud, myRacer, endRace,
    escapeHtml, unlockAudio, noteFlash,
    get settings() { return G.settings; }
  };

  if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', boot);
  else boot();
})(typeof self !== 'undefined' ? self : this);
