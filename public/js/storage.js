/* ===== storage.js — 本機設定與紀錄（只存這台裝置，不上傳、不做伺服器排行榜） ===== */
(function (root) {
  'use strict';
  const KEY = 'caterpillar-race';

  /* 設定檔格式的版本。改 DEFAULTS 只對「沒玩過的人」生效 —— 已經有存檔的人
   * 會把舊值整包蓋回來，所以會影響手感的預設值一改，就要在這裡補一條轉換。 */
  const VERSION = 2;

  const DEFAULTS = {
    v: VERSION,
    nickname: '',
    char: 'lime',
    difficulty: 'normal',
    lastTrack: 'garden',
    aiCount: 3,

    /* 設定彈窗（規劃書 §7.2） */
    bgm: true, bgmVol: 0.32,
    sfx: true, sfxVol: 0.6,
    vibrate: true,
    steerSens: 1,          /* 0 慢 1 普通 2 快 */
    camMode: 'head',       /* head 鏡頭硬鎖車頭（預設）｜chase 跟平滑後的行進方向｜track 跟賽道方向（比較不會暈） */
    zoomLevel: 1,          /* 鏡頭遠近：0 近 1 普通 2 遠 */
    reduceMotion: false,
    colorAssist: false,
    bigText: false,
    allowBad: true,        /* 負面道具（單機用；線上由房主決定） */

    seenHelp: false,
    seenRotateTip: false,

    /* 紀錄：records[賽道][難度] = { time, lap, date } */
    records: {},
    charUse: {},
    versus: { ai: { win: 0, lose: 0 }, online: { win: 0, lose: 0 } },
    plays: 0
  };

  /**
   * 舊存檔往上帶。
   *
   * 版本 2：鏡頭預設從 chase 改成 head。chase 的軸線有 58% 是「前方賽道的方向」，
   * 所以畫面會自己轉 —— 那是它的設計，不是 bug，但不是一般賽車的手感。
   * 存著 chase 的人幾乎都不是自己挑的（那是當時的預設值），所以一起帶過去；
   * 特地挑過 track 的人就留著 track，不動。
   */
  function migrate(raw) {
    if ((raw.v || 1) < 2 && raw.camMode === 'chase') raw.camMode = 'head';
    raw.v = VERSION;
    return raw;
  }

  function load() {
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { raw = null; }
    const data = Object.assign({}, DEFAULTS, raw ? migrate(raw) : {});
    data.records = Object.assign({}, (raw && raw.records) || {});
    data.charUse = Object.assign({}, (raw && raw.charUse) || {});
    data.versus = {
      ai: Object.assign({ win: 0, lose: 0 }, (raw && raw.versus && raw.versus.ai) || {}),
      online: Object.assign({ win: 0, lose: 0 }, (raw && raw.versus && raw.versus.online) || {})
    };
    return data;
  }

  function save(data) {
    try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) { /* 無痕模式等等，忽略 */ }
  }

  /**
   * 一局結束後記一筆。
   * @returns {{record:boolean, lapRecord:boolean, best:object}}
   */
  function record(data, info) {
    const tid = info.track || 'garden';
    const diff = info.difficulty || 'normal';
    if (!data.records[tid]) data.records[tid] = {};
    const prev = data.records[tid][diff] || { time: 0, lap: 0, date: '' };
    const isRecord = info.finished && (!prev.time || info.time < prev.time);
    const isLap = info.bestLap > 0 && (!prev.lap || info.bestLap < prev.lap);
    data.records[tid][diff] = {
      time: isRecord ? +info.time : prev.time,
      lap: isLap ? +info.bestLap : prev.lap,
      date: (isRecord || isLap) ? new Date().toISOString().slice(0, 10) : prev.date
    };
    if (info.char) data.charUse[info.char] = (data.charUse[info.char] || 0) + 1;
    data.plays = (data.plays || 0) + 1;
    if (info.versus && info.versus.kind) {
      const bucket = data.versus[info.versus.kind];
      if (bucket) { if (info.versus.win) bucket.win++; else bucket.lose++; }
    }
    save(data);
    return { record: isRecord, lapRecord: isLap, best: data.records[tid][diff] };
  }

  function best(data, track, difficulty) {
    return (data.records[track] && data.records[track][difficulty]) || null;
  }

  function clearRecords(data) {
    data.records = {}; data.charUse = {}; data.plays = 0;
    data.versus = { ai: { win: 0, lose: 0 }, online: { win: 0, lose: 0 } };
    save(data);
    return data;
  }

  function resetSettings(data) {
    const keep = {
      records: data.records, charUse: data.charUse, versus: data.versus, plays: data.plays,
      nickname: data.nickname, char: data.char
    };
    const next = Object.assign({}, DEFAULTS, keep);
    save(next);
    return next;
  }

  function favoriteChar(data) {
    let bestId = null, n = 0;
    for (const id in data.charUse) if (data.charUse[id] > n) { n = data.charUse[id]; bestId = id; }
    return bestId;
  }

  root.Store = { load, save, record, best, clearRecords, resetSettings, favoriteChar, DEFAULTS, KEY };
})(typeof self !== 'undefined' ? self : this);
