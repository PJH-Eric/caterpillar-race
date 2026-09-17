/* ===== lib/match-loop.js — 30Hz 權威迴圈、快照廣播、心跳掃描 =====
 *
 * 伺服器是唯一的真相：所有人的輸入送進來，這裡跑 rules.js，再把快照發出去。
 * 前端會自己先跑一份預測讓畫面順，但誰贏誰輸一律以這裡為準。
 *
 * 快照每兩個 tick 發一次（15Hz）。30Hz 全發的話，六個人的房間大概是每秒 100KB，
 * 免費方案的頻寬撐不住；前端本來就有預測，15Hz 已經夠順。
 */
'use strict';

const Rules = require('../public/js/rules.js');
const Tracks = require('../public/js/tracks.js');
const RNG = require('../public/js/rng.js');

const HZ = 30;
const SNAP_EVERY = 2;

function createLoop(hub, io, opt) {
  opt = opt || {};
  const log = opt.log || function () {};
  /** personId → 最新輸入 */
  const inputs = new Map();
  let timer = null;
  let ticks = 0;
  let lobbyDirty = true;

  /* ---------- 開一局 ---------- */

  function startRace(room) {
    const seats = hub.connectedSeats(room).slice().sort((a, b) => a.seat - b.seat);
    if (seats.length < hub.CONST.SEATS_MIN) return { ok: false, reason: '至少要兩個人才能開跑' };

    const seed = 'cr-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36);
    const track = Tracks.get(room.trackId, seed);
    /* 衝刺賽道是起點到終點，沒有圈數概念 —— 只需跑完一趟；隨機賽道則依生成的長度決定圈數 */
    const laps = track.open ? 1 : (room.trackId === 'random' ? track.laps : room.laps);
    room.seed = seed;
    room.phase = 'racing';
    room.results = null;
    room.state = Rules.createRace({
      track: track,
      laps: laps,
      seed: seed,
      allowBad: room.allowBad,
      racers: seats.map(m => ({ id: m.id, name: m.name, char: m.char, kind: 'human', difficulty: 'normal' }))
    });
    for (const m of room.members) m.ready = false;
    for (const m of seats) inputs.set(m.id, { steer: 0, gas: 0, man: 0, use: false });

    const payload = {
      type: 'start',
      seed: seed,
      trackId: room.trackId,
      laps: laps,
      allowBad: room.allowBad,
      racers: room.state.racers.map(r => ({ id: r.id, name: r.name, char: r.char })),
      you: null
    };
    for (const m of room.members) {
      io.send(m.id, Object.assign({}, payload, { you: m.id, role: m.role }));
    }
    lobbyDirty = true;
    log('[race] ' + room.id + ' 開跑（' + seats.length + ' 人，' + room.trackId + '）');
    return { ok: true };
  }

  function endRace(room) {
    room.phase = 'result';
    room.results = Rules.results(room.state);
    for (const m of room.members) {
      io.send(m.id, { type: 'over', results: room.results, roomId: room.id });
    }
    hub.sys(room, (room.results[0] ? room.results[0].name : '有人') + ' 第一名');
    log('[race] ' + room.id + ' 結束');

    /* 對局中掉線的人是為了「30 秒內回得來」才留著的，比賽結束就沒有理由再佔位子。
     * 不清掉的話，房間永遠不會變空，也就永遠關不掉（邀請連結也跟著永遠有效）。 */
    for (const m of room.members.slice()) {
      if (!m.connected) {
        inputs.delete(m.id);
        hub.leave(m.id);
      }
    }
    lobbyDirty = true;
    if (hub.rooms.has(room.id)) sendRoom(room);
  }

  /** 結算後回房間 */
  function backToRoom(room) {
    if (room.phase !== 'result') return;
    room.phase = 'lobby';
    room.state = null;
    for (const m of room.members) m.ready = false;
    lobbyDirty = true;
    sendRoom(room);
  }

  /* ---------- 每個 tick ---------- */

  function tick() {
    ticks++;
    const now = Date.now();

    /* 掉線太久的人：這一局退賽 */
    const gone = hub.sweepGhosts(now);
    for (const g of gone) {
      if (g.room.state) Rules.markGhost(g.room.state, g.member.id, true);
      inputs.delete(g.member.id);
      sendRoom(g.room);
    }

    for (const room of Array.from(hub.rooms.values())) {
      if (room.phase !== 'racing' || !room.state) continue;

      /* 掉線的人幽靈化：停在原地、不參與碰撞，位置保留等他回來 */
      for (const m of room.members) {
        if (m.role !== 'player') continue;
        const r = room.state.racers.find(x => x.id === m.id);
        if (!r) continue;
        if (!m.connected && !r.ghost) Rules.markGhost(room.state, m.id, true);
        if (m.connected && r.ghost) Rules.markGhost(room.state, m.id, false);
      }

      const frame = {};
      for (const r of room.state.racers) {
        frame[r.id] = inputs.get(r.id) || { steer: 0, gas: 0, man: 0, use: false };
      }
      Rules.step(room.state, frame);
      /* use 是邊緣觸發，用掉就收回，不然會一路連發 */
      for (const id of inputs.keys()) {
        const it = inputs.get(id);
        if (it && it.use) inputs.set(id, { steer: it.steer, gas: it.gas || 0, man: it.man || 0, use: false });
      }

      if (ticks % SNAP_EVERY === 0 || room.state.events.length) {
        const snap = Rules.snapshot(room.state);
        const events = room.state.events.slice();
        for (const m of room.members) {
          io.send(m.id, { type: 'snap', s: snap, e: events });
        }
      }

      if (room.state.phase === 'finished') endRace(room);
    }

    /* 網路層心跳：每秒 ping 一次，靠瀏覽器自動回的 pong 判斷連線還在不在 */
    if (ticks % HZ === 0) io.pingAll();
    if (lobbyDirty && ticks % 15 === 0) sendLobby();
  }

  /* ---------- 廣播 ---------- */

  function sendRoom(room) {
    if (!room || !hub.rooms.has(room.id)) return;
    for (const m of room.members) {
      io.send(m.id, { type: 'room', room: hub.viewOf(room, m.id), quick: hub.QUICK });
    }
    lobbyDirty = true;
  }

  function sendLobby(force) {
    if (!force && !lobbyDirty) return;
    lobbyDirty = false;
    const list = hub.listRooms();
    for (const id of io.lobbyIds()) io.send(id, { type: 'rooms', rooms: list });
  }

  function setInput(personId, msg) {
    const prev = inputs.get(personId) || { steer: 0, gas: 0, man: 0, use: false };
    inputs.set(personId, {
      steer: Math.max(-1, Math.min(1, Math.round(Number(msg.steer) || 0))),
      gas: Math.max(-1, Math.min(1, Math.round(Number(msg.gas) || 0))),
      man: msg.man ? 1 : 0,
      /* 這個 tick 還沒被用掉的 use 要保留，不然快速連按會掉 */
      use: !!msg.use || prev.use
    });
  }

  function forget(personId) { inputs.delete(personId); }

  function start() {
    if (timer) return;
    timer = setInterval(tick, 1000 / HZ);
  }
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    hz: HZ, start, stop, tick,
    startRace, endRace, backToRoom,
    sendRoom, sendLobby, setInput, forget,
    markDirty() { lobbyDirty = true; },
    get ticks() { return ticks; }
  };
}

module.exports = { createLoop, HZ, SNAP_EVERY };
