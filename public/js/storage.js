/* ===== storage.js — 本機設定與紀錄（只存這台裝置，不上傳、不做伺服器排行榜） ===== */
(function (root) {
  'use strict';
  const KEY = 'caterpillar-race';

  /* 設定檔格式的版本。改 DEFAULTS 只對「沒玩過的人」生效 —— 已經有存檔的人
   * 會把舊值整包蓋回來，所以會影響手感的預設值一改，就要在這裡補一條轉換。 */
  const VERSION = 3;

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
   * 版本 3：鏡頭不再是可設定的項目（只有一種：鎖在車頭上），
   * 所以把 camMode／camTurnSpeed 從存檔裡清掉，免得一直帶著沒人讀的鍵。
   *
   * 版本號只能往上加：存檔裡已經寫著 v:2 的人，降版會讓下次載入又跑一次轉換。
   */
  function migrate(raw) {
    if ((raw.v || 1) < 3) {
      delete raw.camMode;
      delete raw.camTurnSpeed;
    }
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
