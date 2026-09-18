/* ===== audio.js — 程序化 BGM 與音效（Web Audio，不依賴外部音檔） =====
 *
 * 六個賽道主題共用同一段木琴童謠主旋律，只換樂器音色與變奏，
 * 這樣整套聽起來是同一個遊戲，換賽道又有新鮮感。
 * 瀏覽器規定要有使用者手勢才能出聲，所以 unlock() 必須在第一次點擊時呼叫。
 */
(function (root) {
  'use strict';

  /* 主旋律（半音相對值，null＝休止），四小節一循環 */
  const MELODY = [
    0, 4, 7, 4, 9, 7, 4, 2,
    0, 4, 7, 12, 11, 7, 4, null,
    5, 9, 12, 9, 7, 4, 0, 2,
    4, 7, 4, 0, -1, 0, null, null
  ];
  const BASS = [0, null, 7, null, 5, null, 7, null];

  /* 每個主題的樂器與調性 */
  const VOICES = {
    garden: { wave: 'triangle', root: 69, decay: 0.42, bassWave: 'sine', bright: 1.0 },
    veggie: { wave: 'square', root: 67, decay: 0.30, bassWave: 'triangle', bright: 0.75 },
    branch: { wave: 'sine', root: 65, decay: 0.55, bassWave: 'sine', bright: 0.9 },
    pond: { wave: 'sine', root: 72, decay: 0.62, bassWave: 'triangle', bright: 1.1 },
    candy: { wave: 'triangle', root: 74, decay: 0.26, bassWave: 'square', bright: 1.2 },
    shroom: { wave: 'sawtooth', root: 62, decay: 0.48, bassWave: 'sine', bright: 0.6 },
    /* 海灣：明亮開闊，尾音拖長一點像風 */
    beach: { wave: 'triangle', root: 71, decay: 0.70, bassWave: 'sine', bright: 1.15 },
    /* 峽谷：低、乾、短促，像在石頭之間彈回來 */
    canyon: { wave: 'square', root: 60, decay: 0.34, bassWave: 'triangle', bright: 0.7 },
    /* 雪地：高、清透，衰減最長 */
    snow: { wave: 'sine', root: 76, decay: 0.80, bassWave: 'sine', bright: 1.25 },
    /* 花海：比花園再亮一點、再軟一點，像一整片風吹過去 */
    bloom: { wave: 'triangle', root: 73, decay: 0.58, bassWave: 'sine', bright: 1.18 },
    /* 火山：最低最悶，短促帶顆粒，像隔著岩壁聽到的 */
    volcano: { wave: 'sawtooth', root: 57, decay: 0.30, bassWave: 'square', bright: 0.55 },
    /* 星空：高、稀薄、尾音很長，像夜裡的鐘 */
    starry: { wave: 'sine', root: 79, decay: 0.90, bassWave: 'triangle', bright: 1.3 },
    /* 市中心：方波帶一點顆粒，短促乾淨，像街上的電子招牌 */
    city: { wave: 'square', root: 70, decay: 0.28, bassWave: 'square', bright: 0.95 },
    /* 高速公路：最快最亮，衰減短 —— 一路往前不回頭的感覺 */
    highway: { wave: 'sawtooth', root: 74, decay: 0.22, bassWave: 'square', bright: 1.1 },
    /* 夜間街道：低、悶、尾音長，像空蕩街上的回音 */
    cityNight: { wave: 'sine', root: 61, decay: 0.75, bassWave: 'sine', bright: 0.62 }
  };

  function midi(n) { return 440 * Math.pow(2, (n - 69) / 12); }

  function create() {
    let ctx = null;
    let master = null, bgmGain = null, sfxGain = null;
    let timer = null, step = 0, theme = 'garden';
    let settings = { bgm: true, bgmVol: 0.32, sfx: true, sfxVol: 0.6 };
    let started = false;

    function unlock() {
      if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return true; }
      const AC = root.AudioContext || root.webkitAudioContext;
      if (!AC) return false;
      try { ctx = new AC(); } catch (e) { return false; }
      master = ctx.createGain(); master.gain.value = 1; master.connect(ctx.destination);
      bgmGain = ctx.createGain(); bgmGain.gain.value = settings.bgm ? settings.bgmVol : 0; bgmGain.connect(master);
      sfxGain = ctx.createGain(); sfxGain.gain.value = settings.sfx ? settings.sfxVol : 0; sfxGain.connect(master);
      return true;
    }

    function apply(s) {
      settings = Object.assign(settings, s || {});
      if (!ctx) return;
      bgmGain.gain.setTargetAtTime(settings.bgm ? settings.bgmVol : 0, ctx.currentTime, 0.05);
      sfxGain.gain.setTargetAtTime(settings.sfx ? settings.sfxVol : 0, ctx.currentTime, 0.05);
    }

    function note(dest, freq, when, dur, wave, vol, bright) {
      if (!ctx) return;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 900 + 2600 * (bright || 1);
      o.type = wave; o.frequency.value = freq;
      g.gain.setValueAtTime(0, when);
      g.gain.linearRampToValueAtTime(vol, when + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0008, when + dur);
      o.connect(f); f.connect(g); g.connect(dest);
      o.start(when); o.stop(when + dur + 0.05);
    }

    /* ---------- BGM ---------- */

    function tick() {
      if (!ctx || !settings.bgm) return;
      const v = VOICES[theme] || VOICES.garden;
      const now = ctx.currentTime + 0.02;
      const n = MELODY[step % MELODY.length];
      if (n !== null) note(bgmGain, midi(v.root + n), now, v.decay, v.wave, 0.20, v.bright);
      const b = BASS[step % BASS.length];
      if (b !== null) note(bgmGain, midi(v.root - 24 + b), now, 0.45, v.bassWave, 0.16, 0.5);
      /* 第二拍加一個輕輕的八度和聲，旋律才不會太單薄 */
      if (n !== null && step % 4 === 2) note(bgmGain, midi(v.root + 12 + n), now, v.decay * 0.6, v.wave, 0.07, v.bright);
      step++;
    }

    function startBgm(themeId) {
      theme = themeId || theme;
      if (!unlock()) return;
      if (timer) return;
      started = true;
      step = 0;
      timer = setInterval(tick, 260);
    }
    function stopBgm() {
      if (timer) { clearInterval(timer); timer = null; }
      started = false;
    }
    function setTheme(themeId) {
      theme = themeId || theme;
    }

    /* ---------- 音效 ---------- */

    function noise(when, dur, vol, freq, q) {
      if (!ctx) return;
      const len = Math.ceil(ctx.sampleRate * dur);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const src = ctx.createBufferSource(); src.buffer = buf;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q || 1;
      const g = ctx.createGain(); g.gain.value = vol;
      src.connect(f); f.connect(g); g.connect(sfxGain);
      src.start(when);
    }

    function sweep(when, from, to, dur, wave, vol) {
      if (!ctx) return;
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.type = wave || 'sine';
      o.frequency.setValueAtTime(from, when);
      o.frequency.exponentialRampToValueAtTime(Math.max(20, to), when + dur);
      g.gain.setValueAtTime(vol, when);
      g.gain.exponentialRampToValueAtTime(0.0008, when + dur);
      o.connect(g); g.connect(sfxGain);
      o.start(when); o.stop(when + dur + 0.03);
    }

    const SFX = {
      pad(t) { sweep(t, 700, 1900, 0.2, 'sine', 0.18); },                /* 加速帶 */
      pick(t) { sweep(t, 880, 1760, 0.14, 'triangle', 0.2); },           /* 吃道具葉：叮 */
      wall(t) { noise(t, 0.16, 0.3, 220, 0.8); },                        /* 撞牆：噗 */
      bump(t) { noise(t, 0.09, 0.16, 320, 1.2); },
      goo(t) { sweep(t, 300, 110, 0.26, 'sine', 0.24); },                /* 踩黏液：啵 */
      splash(t) { noise(t, 0.18, 0.22, 900, 2.4); sweep(t, 1500, 600, 0.14, 'sine', 0.10); }, /* 踩水坑：嘩 */
      blocked(t) { sweep(t, 1200, 300, 0.25, 'sine', 0.22); },           /* 泡泡破 */
      hit(t) { sweep(t, 520, 180, 0.2, 'square', 0.16); },
      lap(t) { sweep(t, 900, 1400, 0.12, 'triangle', 0.2); sweep(t + 0.1, 1400, 1800, 0.14, 'triangle', 0.18); },
      count(t) { sweep(t, 600, 600, 0.12, 'square', 0.18); },
      go(t) { sweep(t, 700, 1400, 0.3, 'square', 0.22); },
      finish(t) {
        [0, 4, 7, 12].forEach((n, i) => sweep(t + i * 0.09, midi(69 + n), midi(69 + n), 0.3, 'triangle', 0.2));
      },
      tap(t) { sweep(t, 620, 820, 0.07, 'sine', 0.12); }
    };

    function play(name) {
      if (!ctx || !settings.sfx || !SFX[name]) return;
      SFX[name](ctx.currentTime + 0.005);
    }

    return {
      unlock, apply, play, startBgm, stopBgm, setTheme,
      get ready() { return !!ctx; },
      get playing() { return started; },
      get settings() { return settings; },
      MELODY, VOICES, SFX_NAMES: Object.keys(SFX)
    };
  }

  const api = { create, MELODY, VOICES, midi };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Audio2 = api;
})(typeof self !== 'undefined' ? self : this);
