/* ===== lib/protocol.js — 客戶端訊息 → 房間邏輯與遊戲迴圈 =====
 *
 * 所有權限檢查都在這裡：誰能改房間設定、誰能踢人、誰能撤銷邀請連結、
 * 觀戰者不能送輸入。前端的按鈕會不會出現是另一回事，這裡一律再檢查一次。
 */
'use strict';

function createProtocol(hub, loop, io) {

  function err(person, text) {
    io.send(person.id, { type: 'error', text: text });
  }

  function sendRoomOf(person) {
    const room = hub.roomOf(person.id);
    if (room) loop.sendRoom(room);
  }

  const handlers = {

    /** 報到：帶暱稱與角色 */
    hi(person, msg) {
      person.name = hub.clean(msg.name, hub.CONST.NAME_MAX) || '毛毛蟲';
      person.char = String(msg.char || 'lime').slice(0, 16);
      io.send(person.id, { type: 'me', id: person.id, name: person.name, char: person.char });
      loop.sendLobby(true);
    },

    rooms(person) {
      io.send(person.id, { type: 'rooms', rooms: hub.listRooms() });
    },

    create(person, msg) {
      if (hub.roomOf(person.id)) return err(person, '你已經在一個房間裡了');
      const room = hub.createRoom(person, msg || {});
      loop.sendRoom(room);
      loop.sendLobby(true);
    },

    /** 快速加入：有等人的房就進去，沒有就自動開一間 */
    quick(person) {
      if (hub.roomOf(person.id)) return err(person, '你已經在一個房間裡了');
      const r = hub.quickJoin(person);
      loop.sendRoom(r.room);
      loop.sendLobby(true);
    },

    join(person, msg) {
      if (hub.roomOf(person.id)) return err(person, '你已經在一個房間裡了');
      const roomId = String(msg.roomId || '');
      /* 帶 token 進來的是邀請連結，要先驗證；直接從大廳點的房間不需要 */
      if (msg.token) {
        const v = hub.verifyInvite(roomId, msg.token);
        if (!v.ok) {
          io.send(person.id, { type: 'invite-bad', reason: v.reason, text: v.text });
          return;
        }
      }
      const room = hub.rooms.get(roomId);
      if (!room) return err(person, '找不到這個房間，它可能已經結束了');
      const r = hub.join(room, person, msg.role === 'spectator' ? 'spectator' : 'player');
      if (!r.ok) return err(person, r.reason);
      if (r.switched) {
        io.send(person.id, {
          type: 'notice',
          text: room.phase === 'racing' ? '比賽已經開始了，你先在觀戰席看，下一局可以上場' : '玩家席位滿了，你先在觀戰席'
        });
      }
      loop.sendRoom(room);
      loop.sendLobby(true);
    },

    leaveRoom(person) {
      const room = hub.roomOf(person.id);
      if (!room) return;
      loop.forget(person.id);
      /* 對局中離開＝退賽，毛毛蟲要從賽道上拿掉 */
      if (room.state) {
        const Rules = require('../public/js/rules.js');
        Rules.markGhost(room.state, person.id, true);
      }
      const res = hub.leave(person.id);
      person.roomId = null;
      person.role = null;
      io.send(person.id, { type: 'left' });
      if (res && !res.closed) loop.sendRoom(res.room);
      loop.sendLobby(true);
    },

    ready(person, msg) {
      const room = hub.roomOf(person.id);
      if (!room) return;
      if (room.phase !== 'lobby') return err(person, '現在不是準備的時候');
      if (room.ownerId === person.id) return err(person, '房主請按「開始遊戲」，不需要準備');
      if (!hub.setReady(room, person.id, msg.ready !== false)) return err(person, '觀戰席不用準備');
      loop.sendRoom(room);
    },

    /** 只有房主能明確開始，其他玩家先按準備。 */
    start(person) {
      const room = hub.roomOf(person.id);
      if (!room) return;
      if (room.phase !== 'lobby') return err(person, '現在不能開始遊戲');
      if (room.ownerId !== person.id) return err(person, '只有房主可以開始遊戲');
      if (!hub.allReady(room)) return err(person, '請等其他玩家都準備好');
      const r = loop.startRace(room);
      if (!r.ok) { err(person, r.reason); loop.sendRoom(room); return; }
      loop.sendRoom(room);
    },

    setup(person, msg) {
      const room = hub.roomOf(person.id);
      if (!room) return;
      const r = hub.setup(room, person.id, msg || {});
      if (!r.ok) return err(person, r.reason);
      loop.sendRoom(room);
      loop.sendLobby(true);
    },

    switch(person, msg) {
      const room = hub.roomOf(person.id);
      if (!room) return;
      const r = hub.switchRole(room, person.id, msg.role === 'player' ? 'player' : 'spectator');
      if (!r.ok) return err(person, r.reason);
      person.role = r.role;
      loop.sendRoom(room);
      loop.sendLobby(true);
    },

    kick(person, msg) {
      const room = hub.roomOf(person.id);
      if (!room) return;
      const target = String(msg.id || '');
      const r = hub.kick(room, person.id, target);
      if (!r.ok) return err(person, r.reason);
      io.send(target, { type: 'kicked' });
      loop.forget(target);
      loop.sendRoom(room);
      loop.sendLobby(true);
    },

    invite(person, msg) {
      const room = hub.roomOf(person.id);
      if (!room) return;
      const r = (msg.action === 'revoke')
        ? hub.revokeInvite(room, person.id)
        : hub.issueInvite(room, person.id);
      if (!r.ok) return err(person, r.reason);
      loop.sendRoom(room);
    },

    chat(person, msg) {
      const room = hub.roomOf(person.id);
      if (!room) return;
      const m = hub.chat(room, person.id, msg.text);
      if (!m) return;
      for (const mem of room.members) io.send(mem.id, { type: 'chat', msg: m });
    },

    /** 對局中的輸入。觀戰者送來的一律丟掉。 */
    input(person, msg) {
      const room = hub.roomOf(person.id);
      if (!room || room.phase !== 'racing') return;
      const me = hub.memberOf(room, person.id);
      if (!me || me.role !== 'player') return;
      loop.setInput(person.id, msg);
    },

    /** 結算後回房間 */
    again(person) {
      const room = hub.roomOf(person.id);
      if (!room) return;
      loop.backToRoom(room);
    },

    /** 應用層心跳（網路層的 ping/pong 才是判斷依據，這個只是加分） */
    beat(person) {
      hub.markConnected(person.id);
    }
  };

  function handle(person, msg) {
    if (!msg || typeof msg.type !== 'string') return;
    const fn = handlers[msg.type];
    if (!fn) return;
    hub.markConnected(person.id);
    fn(person, msg);
  }

  return { handle, handlers, sendRoomOf };
}

module.exports = { createProtocol };
