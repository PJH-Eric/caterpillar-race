/* ===== lib/rooms.js — 房間、席位、觀戰、邀請、聊天（純邏輯，不碰 socket） =====
 *
 * 這一支不知道 WebSocket 的存在，也不知道遊戲怎麼跑；
 * 它只回答「誰在哪個房間、是什麼身分、能做什麼」。
 * 這樣測試可以直接叫函式，不必開伺服器。
 */
'use strict';

const crypto = require('crypto');
const Tracks = require('../public/js/tracks.js');

const CONST = {
  SEATS_MAX: 6,          /* 一條賽道最多 6 隻毛毛蟲 */
  SEATS_MIN: 2,
  SEATS_DEFAULT: 4,
  SPECTATORS: 20,        /* 觀戰席上限，滿了顯示「觀戰席已滿」 */
  GRACE_MS: 30000,       /* 對局中掉線多久算退賽 */
  CHAT_KEEP: 60,
  NAME_MAX: 8,
  TEXT_MAX: 40
};

const QUICK = ['加油！', '好厲害', '等等我', '哎呀', '再來一局', '換賽道吧'];

function id(n) { return crypto.randomBytes(n || 4).toString('hex'); }

/** 去掉控制字元並限長。聊天與暱稱都要過這一關。 */
function clean(s, max) {
  const str = String(s == null ? '' : s);
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 32 || c === 127) continue;
    out += str[i];
  }
  return out.trim().slice(0, max);
}

function createHub() {
  const rooms = new Map();      /* roomId → room */
  const where = new Map();      /* personId → roomId */

  function createRoom(person, opt) {
    opt = opt || {};
    const room = {
      id: 'r' + id(3),
      name: clean(opt.name, 12) || (clean(person.name, CONST.NAME_MAX) || '毛毛蟲') + ' 的房間',
      ownerId: person.id,
      trackId: opt.trackId || 'garden',
      laps: Math.max(1, Math.min(5, Number(opt.laps) || (Tracks.BY_ID[opt.trackId || 'garden'] || {}).laps || 3)),
      seats: Math.max(CONST.SEATS_MIN, Math.min(CONST.SEATS_MAX, Number(opt.seats) || CONST.SEATS_DEFAULT)),
      allowBad: opt.allowBad !== false,
      phase: 'lobby',            /* lobby → racing → result → lobby */
      members: [],
      chat: [],
      invite: { token: id(8), revoked: false },
      seed: null,
      results: null,
      createdAt: Date.now()
    };
    rooms.set(room.id, room);
    join(room, person, 'player');
    return room;
  }

  function roomOf(personId) {
    const rid = where.get(personId);
    return rid ? rooms.get(rid) || null : null;
  }
  function memberOf(room, personId) {
    return room ? room.members.find(m => m.id === personId) || null : null;
  }
  function seatsOf(room) { return room.members.filter(m => m.role === 'player'); }
  function specsOf(room) { return room.members.filter(m => m.role === 'spectator'); }
  function connectedSeats(room) { return seatsOf(room).filter(m => m.connected); }

  function freeSeat(room) {
    const taken = {};
    for (const m of seatsOf(room)) taken[m.seat] = true;
    for (let i = 0; i < room.seats; i++) if (!taken[i]) return i;
    return -1;
  }

  /**
   * 進房間。want 是 'player' 或 'spectator'。
   * 席位滿了或對局進行中會自動轉成觀戰，而且會在回傳值標明 switched，
   * 不能默默把觀戰者當成玩家。
   */
  function join(room, person, want) {
    if (!room) return { ok: false, reason: '找不到這個房間' };
    const already = memberOf(room, person.id);
    if (already) return { ok: true, role: already.role, seat: already.seat };

    let role = want === 'spectator' ? 'spectator' : 'player';
    let seat = -1;
    if (role === 'player') {
      if (room.phase === 'racing') role = 'spectator';
      else {
        seat = freeSeat(room);
        if (seat < 0) role = 'spectator';
      }
    }
    if (role === 'spectator' && specsOf(room).length >= CONST.SPECTATORS) {
      return { ok: false, reason: '觀戰席已滿' };
    }

    room.members.push({
      id: person.id,
      name: clean(person.name, CONST.NAME_MAX) || '毛毛蟲',
      char: person.char || 'lime',
      role: role, seat: seat,
      ready: false,
      connected: true,
      lastSeen: Date.now()
    });
    where.set(person.id, room.id);
    person.roomId = room.id;
    person.role = role;
    sys(room, (person.name || '有人') + (role === 'player' ? ' 進來了' : ' 來看比賽'));
    return { ok: true, role: role, seat: seat, switched: role === 'spectator' && want !== 'spectator' };
  }

  function leave(personId) {
    const room = roomOf(personId);
    if (!room) return null;
    const m = memberOf(room, personId);
    room.members = room.members.filter(x => x.id !== personId);
    where.delete(personId);
    if (m) sys(room, m.name + ' 離開了');

    /* 沒人就立刻關房，邀請連結一起失效 */
    if (!room.members.length) {
      rooms.delete(room.id);
      return { room: room, closed: true };
    }
    if (room.ownerId === personId) {
      const next = seatsOf(room)[0] || room.members[0];
      room.ownerId = next.id;
      sys(room, next.name + ' 成為新房主');
    }
    return { room: room, closed: false };
  }

  function switchRole(room, personId, want) {
    const m = memberOf(room, personId);
    if (!m) return { ok: false, reason: '你不在這個房間' };
    if (want === 'spectator') {
      if (specsOf(room).length >= CONST.SPECTATORS) return { ok: false, reason: '觀戰席已滿' };
      m.role = 'spectator'; m.seat = -1; m.ready = false;
      sys(room, m.name + ' 換到觀戰席');
      return { ok: true, role: 'spectator' };
    }
    if (room.phase === 'racing') return { ok: false, reason: '比賽進行中，等這一局結束再上場' };
    const seat = freeSeat(room);
    if (seat < 0) return { ok: false, reason: '玩家席位已滿' };
    m.role = 'player'; m.seat = seat; m.ready = false;
    sys(room, m.name + ' 上場了');
    return { ok: true, role: 'player', seat: seat };
  }

  function setReady(room, personId, ready) {
    const m = memberOf(room, personId);
    if (!m || m.role !== 'player') return false;
    m.ready = !!ready;
    return true;
  }

  /** 全員按準備好才開局，而且至少要兩個人 */
  function allReady(room) {
    const seats = connectedSeats(room);
    return seats.length >= CONST.SEATS_MIN && seats.every(m => m.ready);
  }

  function setup(room, personId, opt) {
    if (room.ownerId !== personId) return { ok: false, reason: '只有房主可以改設定' };
    if (room.phase === 'racing') return { ok: false, reason: '比賽進行中不能改設定' };
    if (opt.trackId) {
      room.trackId = String(opt.trackId).slice(0, 16);
      room.laps = (Tracks.BY_ID[room.trackId] || {}).laps || 3;
    }
    if (opt.laps) room.laps = Math.max(1, Math.min(5, Number(opt.laps)));
    if (opt.allowBad !== undefined) room.allowBad = !!opt.allowBad;
    if (opt.seats) {
      const n = Math.max(CONST.SEATS_MIN, Math.min(CONST.SEATS_MAX, Number(opt.seats)));
      room.seats = n;
      /* 調小人數上限時，超出的席位往後移到觀戰席，不能憑空消失 */
      for (const m of seatsOf(room)) {
        if (m.seat >= n) {
          m.role = 'spectator'; m.seat = -1; m.ready = false;
          sys(room, m.name + ' 因為人數上限調整被移到觀戰席');
        }
      }
    }
    /* 設定改了就要重新準備，免得有人在不知情的情況下被拉進新賽道 */
    for (const m of room.members) m.ready = false;
    return { ok: true };
  }

  function kick(room, byId, targetId) {
    if (room.ownerId !== byId) return { ok: false, reason: '只有房主可以請人離開' };
    if (byId === targetId) return { ok: false, reason: '不能踢自己' };
    const m = memberOf(room, targetId);
    if (!m) return { ok: false, reason: '找不到這個人' };
    leave(targetId);
    sys(room, m.name + ' 被房主請離開了');
    return { ok: true };
  }

  /* ---------- 邀請連結：有範圍、有效期限（與房間同生命）與撤銷狀態 ---------- */

  function issueInvite(room, byId) {
    if (room.ownerId !== byId) return { ok: false, reason: '只有房主可以重發邀請連結' };
    room.invite = { token: id(8), revoked: false };
    return { ok: true, token: room.invite.token };
  }
  function revokeInvite(room, byId) {
    if (room.ownerId !== byId) return { ok: false, reason: '只有房主可以撤銷邀請連結' };
    room.invite.revoked = true;
    return { ok: true };
  }
  function verifyInvite(roomId, token) {
    const room = rooms.get(roomId);
    if (!room) return { ok: false, reason: 'gone', text: '這個房間已經結束了' };
    if (!token) return { ok: false, reason: 'missing', text: '這個邀請連結不完整' };
    if (room.invite.revoked) return { ok: false, reason: 'revoked', text: '這個邀請連結已經被房主撤銷了' };
    if (room.invite.token !== token) return { ok: false, reason: 'invalid', text: '這個邀請連結無效，可能已經換過新的了' };
    return { ok: true, room: room };
  }

  /* ---------- 聊天 ---------- */

  function push(room, msg) {
    room.chat.push(msg);
    if (room.chat.length > CONST.CHAT_KEEP) room.chat.splice(0, room.chat.length - CONST.CHAT_KEEP);
  }
  function sys(room, text) {
    push(room, { sys: true, text: clean(text, 60), at: Date.now() });
  }
  function chat(room, personId, text) {
    const m = memberOf(room, personId);
    if (!m) return null;
    const t = clean(text, CONST.TEXT_MAX);
    if (!t) return null;
    const msg = { from: m.id, name: m.name, role: m.role, text: t, at: Date.now() };
    push(room, msg);
    return msg;
  }

  /* ---------- 連線狀態 ---------- */

  function markDisconnected(personId) {
    const room = roomOf(personId);
    if (!room) return null;
    const m = memberOf(room, personId);
    if (!m) return null;
    m.connected = false;
    m.lastSeen = Date.now();
    m.ready = false;
    /* 大廳裡掉線就直接移除；對局中先留著，30 秒內回來可以接回原位 */
    if (room.phase !== 'racing') return leave(personId);
    return { room: room, closed: false, ghost: true };
  }

  function markConnected(personId) {
    const room = roomOf(personId);
    const m = memberOf(room, personId);
    if (m) { m.connected = true; m.lastSeen = Date.now(); }
    return room;
  }

  /** 對局中掉線超過寬限時間的人，視為退賽 */
  function sweepGhosts(now) {
    const out = [];
    for (const room of Array.from(rooms.values())) {
      if (room.phase !== 'racing') continue;
      for (const m of room.members.slice()) {
        if (m.connected || now - m.lastSeen < CONST.GRACE_MS) continue;
        out.push({ room: room, member: m });
        sys(room, m.name + ' 掉線太久，這一局退賽了');
        leave(m.id);
      }
    }
    return out;
  }

  /* ---------- 大廳列表與房間樣貌 ---------- */

  function listRooms() {
    const out = [];
    for (const room of rooms.values()) {
      out.push({
        id: room.id, name: room.name, trackId: room.trackId, laps: room.laps,
        seats: room.seats,
        players: connectedSeats(room).length,
        spectators: specsOf(room).filter(m => m.connected).length,
        phase: room.phase, allowBad: room.allowBad
      });
    }
    out.sort((a, b) => (a.phase === 'lobby' ? 0 : 1) - (b.phase === 'lobby' ? 0 : 1) || b.players - a.players);
    return out;
  }

  /** 傳給客戶端的房間樣貌；邀請 token 只給房主 */
  function viewOf(room, personId) {
    const me = memberOf(room, personId);
    return {
      id: room.id, name: room.name, ownerId: room.ownerId,
      trackId: room.trackId, laps: room.laps, seats: room.seats,
      allowBad: room.allowBad, phase: room.phase,
      youAre: me ? me.role : null,
      isOwner: room.ownerId === personId,
      invite: (room.ownerId === personId && !room.invite.revoked) ? room.invite.token : null,
      inviteRevoked: room.invite.revoked,
      members: room.members.map(m => ({
        id: m.id, name: m.name, char: m.char, role: m.role, seat: m.seat,
        ready: m.ready, connected: m.connected, owner: m.id === room.ownerId
      })),
      chat: room.chat.slice(-30)
    };
  }

  /** 大廳的「快速加入」：有等人的房就進去，沒有就自動開一間 */
  function quickJoin(person) {
    for (const room of rooms.values()) {
      if (room.phase !== 'lobby') continue;
      if (freeSeat(room) < 0) continue;
      const r = join(room, person, 'player');
      if (r.ok) return Object.assign({ room: room }, r);
    }
    const room = createRoom(person, {});
    return { room: room, ok: true, role: 'player', seat: 0, created: true };
  }

  return {
    CONST: CONST, QUICK: QUICK, rooms: rooms, where: where,
    createRoom, join, leave, roomOf, memberOf, seatsOf, specsOf, connectedSeats,
    freeSeat, switchRole, setReady, allReady, setup, kick,
    issueInvite, revokeInvite, verifyInvite,
    chat, sys, listRooms, viewOf, quickJoin,
    markDisconnected, markConnected, sweepGhosts, clean
  };
}

module.exports = { createHub, CONST, QUICK, clean };
