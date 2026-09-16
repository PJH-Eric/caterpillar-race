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
    art: null,                 /* 預先畫好的賽道圖 */
    miniArt: null,
    meId: 'me',
    trails: {},                /* 每隻毛毛蟲的軌跡（純畫面用） */
    cam: { x: 0, y: 0, a: 0, ready: false },
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
      '<p>你不用管油門，毛毛蟲一直在蠕動前進。你只要管三件事：往左轉、往右轉、用道具。</p>' + keyRow +
      '<p>手機和平板上，左下角是左轉、右下角是右轉，中間下方那顆是道具。</p></section>' +

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

    /* 預先把靜態賽道畫成一張圖，之後每幀只 drawImage 一次 */
    G.art = root.Render.buildTrack(G.track, G.theme, RNG.create(seed + ':art'));
    G.miniArt = buildMiniArt();

    /* 軌跡初始化：往後補一段，開局就有身體，不會縮成一坨 */
    G.trails = {};
    for (const r of G.state.racers) {
      const hist = [];
      for (let i = 0; i < 40; i++) {
        hist.push({ x: r.x - Math.cos(r.angle) * i * 2.2, y: r.y - Math.sin(r.angle) * i * 2.2 });
      }
      G.trails[r.id] = hist;
    }

    const me = myRacer();
    G.cam = { x: me.x, y: me.y, a: me.angle, ready: true };
    G.paused = false;
    G.finishedAt = 0;
    G.lastResults = null;
    G.countShown = -1;

    G.hud = { item: undefined, standings: '', rank: -1, lap: -1, note: null, frame: 0 };
    $('chat-dock').hidden = (G.mode !== 'online');
    $('my-rank-total').textContent = '/' + G.state.racers.length;
    $('my-lap-total').textContent = '/' + G.state.laps;
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

  function frame(ms) {
    G.raf = root.requestAnimationFrame(frame);
    if (!G.state) return;
    if (!G.lastMs) G.lastMs = ms;
    let dt = (ms - G.lastMs) / 1000;
    G.lastMs = ms;
    /* 分頁切走再回來會累積一大段時間，夾住免得一次跑幾百個 tick */
    if (dt > 0.25) dt = 0.25;

    if (G.mode === 'online') {
      if (root.Online) root.Online.tick(dt);
    } else if (!G.paused) {
      G.acc += dt;
      let guard = 0;
      while (G.acc >= Rules.C.TICK && guard++ < 8) {
        simTick();
        G.acc -= Rules.C.TICK;
      }
    }

    updateTrails();
    draw();
    updateHud();
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
      inputs[me.id] = { steer: applySens(raw.steer), use: raw.use };
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
   *  六、繪製
   * ================================================================ */

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
    /* 小螢幕看得少一點、大螢幕看得多一點，但不要小到看不見毛毛蟲 */
    G.view.zoom = Math.max(0.95, Math.min(2.1, Math.min(G.view.w, G.view.h) / 420));
    maybeRotateTip();
  }

  function draw() {
    const ctx = G.ctx;
    if (!ctx || !G.state) return;
    const v = G.view, st = G.state;
    const me = myRacer();

    /* 鏡頭：跟隨自己，而且隨車頭旋轉（毛毛蟲永遠朝上） */
    const snap = G.settings.reduceMotion;
    G.cam.x += (me.x - G.cam.x) * (snap ? 1 : 0.35);
    G.cam.y += (me.y - G.cam.y) * (snap ? 1 : 0.35);
    let da = me.angle - G.cam.a;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    G.cam.a += da * (snap ? 1 : 0.18);

    ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
    /* 地圖外用草地深色填滿，撞到世界邊界時才不會看到一大片空白 */
    ctx.fillStyle = G.theme.grassDark;
    ctx.fillRect(0, 0, v.w, v.h);

    ctx.save();
    ctx.translate(v.w / 2, v.h * 0.60);
    ctx.scale(v.zoom, v.zoom);
    ctx.rotate(-G.cam.a - Math.PI / 2);
    ctx.translate(-G.cam.x, -G.cam.y);

    if (G.art && G.art.canvas) ctx.drawImage(G.art.canvas, G.art.ox, G.art.oy);

    /* 黏液 */
    for (const g of st.goo) {
      const grd = ctx.createRadialGradient(g.x, g.y, 2, g.x, g.y, Rules.C.GOO_R);
      grd.addColorStop(0, 'rgba(199,155,232,.95)');
      grd.addColorStop(1, 'rgba(155,105,200,.15)');
      ctx.fillStyle = grd;
      ctx.beginPath(); ctx.arc(g.x, g.y, Rules.C.GOO_R, 0, Math.PI * 2); ctx.fill();
    }

    /* 道具葉 */
    const bob = snap ? 0 : Math.sin(st.t * 3) * 2;
    for (const leaf of st.leaves) {
      if (st.t < leaf.readyAt) continue;
      ctx.save();
      /* 地上的影子：葉子是飄著的，有影子才立體 */
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = '#000';
      ctx.beginPath(); ctx.ellipse(leaf.x + 3, leaf.y + 9, 11, 5, 0, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;

      ctx.translate(leaf.x, leaf.y + bob);
      /* 柔和光暈，不要一塊白色圓餅 */
      const glow = ctx.createRadialGradient(0, 0, 3, 0, 0, 20);
      glow.addColorStop(0, 'rgba(255,255,255,.75)');
      glow.addColorStop(0.55, 'rgba(255,248,190,.35)');
      glow.addColorStop(1, 'rgba(255,248,190,0)');
      ctx.fillStyle = glow;
      ctx.beginPath(); ctx.arc(0, 0, 20, 0, Math.PI * 2); ctx.fill();

      /* 葉子本體：上亮下暗，中間一條主脈 */
      const lg = ctx.createLinearGradient(-8, -12, 8, 12);
      lg.addColorStop(0, '#C6F08C');
      lg.addColorStop(0.5, '#8BD44A');
      lg.addColorStop(1, '#4F9420');
      ctx.fillStyle = lg;
      ctx.beginPath();
      ctx.moveTo(0, -13); ctx.quadraticCurveTo(12, 0, 0, 13); ctx.quadraticCurveTo(-12, 0, 0, -13);
      ctx.fill();
      ctx.strokeStyle = '#3C7A14'; ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, -11); ctx.lineTo(0, 11); ctx.stroke();
      ctx.restore();
    }

    /* 蜘蛛絲 */
    for (const w of st.webs) {
      const a = st.racers.find(r => r.id === w.from), b = st.racers.find(r => r.id === w.to);
      if (!a || !b) continue;
      ctx.strokeStyle = 'rgba(235,240,250,.9)';
      ctx.lineWidth = 2.4; ctx.setLineDash([7, 5]);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.setLineDash([]);
    }

    /* 毛毛蟲：自己最後畫，蓋在最上面 */
    const order = st.racers.slice().sort((p, q) => (p.id === G.meId ? 1 : 0) - (q.id === G.meId ? 1 : 0));
    for (const r of order) drawRacer(ctx, r);

    ctx.restore();

    /* 螢幕座標的東西：名牌要正的，不能跟著鏡頭轉 */
    drawNameplates(ctx);
    drawMini();
    drawCountdown();
  }

  function drawRacer(ctx, r) {
    const ch = Chars.get(r.char);
    const pts = root.Render.sampleTrail(G.trails[r.id] || [{ x: r.x, y: r.y }], root.Render.SEGS, root.Render.SEG_GAP);
    const st = G.state;

    /* 腳下光環：自己金色，別人用自己的深色 */
    ctx.save();
    ctx.globalAlpha = r.ghost ? 0.2 : 0.5;
    ctx.strokeStyle = (r.id === G.meId) ? '#FFD54A' : ch.bodyDark;
    ctx.lineWidth = r.id === G.meId ? 3.4 : 2;
    ctx.beginPath(); ctx.ellipse(r.x, r.y, 20, 15, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();

    root.Render.drawWorm(ctx, ch, pts, {
      t: st.t,
      wiggle: st.t < r.wiggle.until,
      tiny: st.t < r.tinyUntil,
      shield: st.t < r.shieldUntil,
      hop: st.t < r.hopUntil,
      slow: st.t < r.slowUntil,
      ghost: r.ghost,
      reduceMotion: G.settings.reduceMotion
    });
  }

  /** 世界座標 → 螢幕座標（名牌與色彩輔助標記用） */
  function worldToScreen(x, y) {
    const v = G.view;
    const dx = x - G.cam.x, dy = y - G.cam.y;
    const a = -G.cam.a - Math.PI / 2;
    const cos = Math.cos(a), sin = Math.sin(a);
    return {
      x: v.w / 2 + (dx * cos - dy * sin) * v.zoom,
      y: v.h * 0.60 + (dx * sin + dy * cos) * v.zoom
    };
  }

  const SHAPE = { circle: 0, square: 1, heart: 2, drop: 3, star: 4, diamond: 5, leaf: 6, triangle: 7 };

  function drawNameplates(ctx) {
    const v = G.view;
    ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.font = '700 12px "Noto Sans TC", system-ui, sans-serif';
    for (const r of G.state.racers) {
      const p = worldToScreen(r.x, r.y);
      if (p.x < -70 || p.x > v.w + 70 || p.y < -70 || p.y > v.h + 70) continue;
      const ch = Chars.get(r.char);
      const label = r.name + (r.ghost ? '（掉線）' : '');
      const w = ctx.measureText(label).width + (G.settings.colorAssist ? 24 : 14);
      const y = p.y - 26 * v.zoom;
      ctx.globalAlpha = r.ghost ? 0.45 : 0.92;
      ctx.fillStyle = 'rgba(255,253,243,.86)';
      roundRect(ctx, p.x - w / 2, y - 14, w, 18, 9);
      ctx.fill();
      if (G.settings.colorAssist) {
        ctx.fillStyle = ch.bodyDark;
        drawShape(ctx, p.x - w / 2 + 8, y - 5, 4.5, SHAPE[ch.shape] || 0);
      }
      ctx.fillStyle = (r.id === G.meId) ? '#2F6B0C' : '#4A4632';
      ctx.fillText(label, p.x + (G.settings.colorAssist ? 5 : 0), y);
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

  /* ---------- 小地圖：鏡頭會轉，需要一張不轉的圖才知道自己在哪 ---------- */

  function buildMiniArt() {
    const size = 160;
    const b = G.track.bounds;
    const w = b.maxX - b.minX, h = b.maxY - b.minY;
    const s = size / Math.max(w, h);
    const cv = root.Render.makeCanvas(size, size);
    const ctx = cv.getContext('2d');
    const out = { canvas: cv, s, ox: b.minX, oy: b.minY, size, dx: (size - w * s) / 2, dy: (size - h * s) / 2 };
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
    const lapNow = Math.min(st.laps, me.lap + 1);
    if (hud.lap !== lapNow) { hud.lap = lapNow; $('my-lap').textContent = String(lapNow); }
    $('lap-time').textContent = (me.started ? Math.max(0, st.raceT - me.lapStart) : 0).toFixed(2);

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
    $('result-stats').innerHTML =
      '<li>蠕動衝刺<span>' + s.wiggleBoosts + ' 次</span></li>' +
      '<li>吃到加速帶<span>' + s.pads + ' 次</span></li>' +
      '<li>用掉道具<span>' + s.itemsUsed + ' 個（命中 ' + s.itemHits + '）</span></li>' +
      '<li>撞牆<span>' + s.hits + ' 次</span></li>' +
      '<li>跑到草地上<span>' + (s.offTrack / 30).toFixed(1) + ' 秒</span></li>' +
      (rec.record ? '<li><span class="record-badge">破紀錄</span><span>' + me.time.toFixed(2) + 's</span></li>' : '') +
      (rec.lapRecord ? '<li><span class="record-badge">最快單圈</span><span>' + me.bestLap.toFixed(2) + 's</span></li>' : '');

    $('again').textContent = (G.mode === 'online') ? '回房間' : '再來一局';
    G.audio.stopBgm();
    show('result');
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
    $('rotate-ok').addEventListener('click', hideRotateTip);
    $('sum-toggle').addEventListener('click', () => {
      const body = $('sum-body');
      body.hidden = !body.hidden;
      $('sum-toggle').setAttribute('aria-expanded', String(!body.hidden));
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
