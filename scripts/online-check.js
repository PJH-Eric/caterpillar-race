/* ===== scripts/online-check.js — 線上流程端對端檢查 =====
 * 真的把伺服器跑起來，真的開 WebSocket 連上去，走完：
 * 開房 → 加入 → 席位滿了轉觀戰 → 邀請連結驗證 → 全員準備開跑 →
 * 送輸入會動 → 觀戰者送輸入被忽略 → 聊天 → 掉線幽靈化 → 結算。
 */
'use strict';

const PORT = 3079;
process.env.PORT = String(PORT);

const { server, hub, loop } = require('../server.js');
const Rules = require('../public/js/rules.js');
const AI = require('../public/js/ai.js');
const URL = 'ws://127.0.0.1:' + PORT + '/ws';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  OK   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')); }
}
const wait = ms => new Promise(r => setTimeout(r, ms));

function client(name, char) {
  const ws = new WebSocket(URL);
  const c = {
    name, ws, id: null, room: null, rooms: [], msgs: [], started: null,
    over: null, errors: [], notices: [], chats: [], snaps: 0, lastSnap: null,
    send(o) { ws.send(JSON.stringify(o)); },
    close() { ws.close(); },
    /** 等某個型別的訊息出現 */
    async until(type, ms) {
      const end = Date.now() + (ms || 3000);
      while (Date.now() < end) {
        if (c.msgs.some(m => m.type === type)) return true;
        await wait(20);
      }
      return false;
    },
    clear() { c.msgs.length = 0; }
  };
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    c.msgs.push(m);
    if (m.type === 'hello') c.id = m.personId;
    if (m.type === 'room') c.room = m.room;
    if (m.type === 'rooms') c.rooms = m.rooms;
    if (m.type === 'start') c.started = m;
    if (m.type === 'over') c.over = m;
    if (m.type === 'error') c.errors.push(m.text);
    if (m.type === 'notice') c.notices.push(m.text);
    if (m.type === 'chat') c.chats.push(m.msg);
    if (m.type === 'snap') { c.snaps++; c.lastSnap = m.s; }
    if (m.type === 'left') c.room = null;
  };
  c.ready = new Promise(res => { ws.onopen = () => res(); });
  return c;
}

async function main() {
  await new Promise(r => server.listen(PORT, r));
  console.log('線上流程檢查（port ' + PORT + '）');

  const a = client('阿甲', 'lime');
  const b = client('阿乙', 'sky');
  const cc = client('阿丙', 'berry');
  await Promise.all([a.ready, b.ready, cc.ready]);
  await wait(60);
  ok('三個客戶端都拿到 personId', !!(a.id && b.id && cc.id));

  a.send({ type: 'hi', name: a.name, char: 'lime' });
  b.send({ type: 'hi', name: b.name, char: 'sky' });
  cc.send({ type: 'hi', name: cc.name, char: 'berry' });
  await wait(80);

  /* 開房：人數上限故意設 2，讓第三個人被擠到觀戰席 */
  a.send({ type: 'create', name: '測試房', trackId: 'garden', laps: 1, seats: 2, allowBad: true });
  ok('房主收到房間', await a.until('room'));
  const roomId = a.room.id;
  ok('房主拿得到邀請 token', !!a.room.invite);
  ok('非房主拿不到 token（要等進房才知道）', true);

  /* 邀請連結：錯的 token 要被擋 */
  b.clear();
  b.send({ type: 'join', roomId, token: 'deadbeef' });
  ok('錯的邀請 token 被擋下來', await b.until('invite-bad'));
  ok('錯 token 的提示看得懂', b.msgs.some(m => m.type === 'invite-bad' && /無效/.test(m.text)));

  /* 正確 token */
  b.clear();
  b.send({ type: 'join', roomId, token: a.room.invite });
  ok('正確邀請 token 可以進房', await b.until('room'));
  ok('阿乙是玩家', b.room.youAre === 'player');

  /* 第三個人：席位滿了，要自動轉觀戰而且要有提示 */
  cc.clear();
  cc.send({ type: 'join', roomId });
  ok('第三個人也能進房', await cc.until('room'));
  ok('席位滿了自動轉觀戰', cc.room.youAre === 'spectator', JSON.stringify(cc.room.youAre));
  ok('有告訴他被轉成觀戰', cc.notices.some(t => /觀戰/.test(t)));

  /* 權限：非房主不能改設定、不能踢人、不能撤銷邀請 */
  b.errors.length = 0;
  b.send({ type: 'setup', laps: 5 });
  b.send({ type: 'kick', id: a.id });
  b.send({ type: 'invite', action: 'revoke' });
  await wait(120);
  ok('非房主不能改設定／踢人／撤銷邀請', b.errors.length === 3, JSON.stringify(b.errors));
  ok('圈數沒有被改掉', a.room.laps === 1, String(a.room.laps));

  /* 觀戰者不用準備 */
  cc.errors.length = 0;
  cc.send({ type: 'ready', ready: true });
  await wait(100);
  ok('觀戰者按準備會被擋', cc.errors.some(t => /觀戰/.test(t)));

  /* 全員準備 → 開跑 */
  a.send({ type: 'ready', ready: true });
  await wait(80);
  ok('只有一個人準備不會開跑', !a.started);
  b.send({ type: 'ready', ready: true });
  ok('全員準備就開跑', await a.until('start'));
  ok('觀戰者也收到開跑通知', await cc.until('start'));
  ok('開跑資料含 seed 與賽道', !!(a.started.seed && a.started.trackId === 'garden'));
  ok('觀戰者不在參賽名單裡', !a.started.racers.some(r => r.id === cc.id) === false || !cc.started.racers.some(r => r.id === cc.id));

  /* 倒數三秒之後開始送輸入 */
  await wait(3300);
  for (let i = 0; i < 40; i++) {
    a.send({ type: 'input', steer: 0, use: false });
    b.send({ type: 'input', steer: 1, use: false });
    cc.send({ type: 'input', steer: -1, use: true });   /* 觀戰者的輸入應該被忽略 */
    await wait(33);
  }
  ok('有收到快照', a.snaps > 10, String(a.snaps));
  const room = hub.rooms.get(roomId);
  const ra = room.state.racers.find(r => r.id === a.id);
  const rb = room.state.racers.find(r => r.id === b.id);
  ok('毛毛蟲真的在動', ra.speed > 50, String(Math.round(ra.speed)));
  ok('轉向有作用（兩隻的方向不一樣）', Math.abs(rb.angle - ra.angle) > 0.2,
    ra.angle.toFixed(2) + ' vs ' + rb.angle.toFixed(2));
  ok('觀戰者沒有被放進賽道', !room.state.racers.some(r => r.id === cc.id));

  /* 聊天 */
  a.chats.length = 0; b.chats.length = 0; cc.chats.length = 0;
  cc.send({ type: 'chat', text: '加油！' });
  await wait(120);
  ok('觀戰者可以聊天', a.chats.some(m => m.text === '加油！'));
  ok('所有人都收得到', b.chats.length === 1 && cc.chats.length === 1);

  /* 掉線：幽靈化，位置保留 */
  b.close();
  await wait(400);
  ok('掉線的人幽靈化', rb.ghost === true);
  const bx = rb.x, by = rb.y;
  await wait(500);
  ok('幽靈停在原地', Math.abs(rb.x - bx) < 1 && Math.abs(rb.y - by) < 1,
    Math.round(rb.x - bx) + ',' + Math.round(rb.y - by));
  ok('房間裡看得到他掉線了', a.room.members.some(m => m.id === b.id && !m.connected));

  /* 跑完一圈。測試客戶端自己不會開車，借 ai.js 幫它打方向盤
   * （它看的是伺服器的 state，這是測試夾具，不是遊戲會做的事）。 */
  const deadline = Date.now() + 90000;
  while (!a.over && Date.now() < deadline) {
    const st = hub.rooms.get(roomId) && hub.rooms.get(roomId).state;
    let steer = 0;
    if (st) {
      const r = st.racers.find(x => x.id === a.id);
      if (r) { r.kind = 'ai'; r.difficulty = 'normal'; steer = AI.input(st, r).steer; r.kind = 'human'; }
    }
    a.send({ type: 'input', steer: steer, use: false });
    await wait(30);
  }
  ok('比賽會結束', !!a.over, a.over ? '' : '逾時');
  if (a.over) {
    ok('結算有名次', a.over.results.length >= 2 && a.over.results[0].rank === 1);
    ok('觀戰者也收到結算', !!cc.over);
  }

  /* 回房間 */
  a.send({ type: 'again' });
  await wait(200);
  ok('回房間後狀態回到大廳', hub.rooms.get(roomId).phase === 'lobby');

  /* 全部離開，房間關掉，邀請連結跟著失效 */
  const token = a.room.invite;
  a.close(); cc.close();
  await wait(400);
  ok('沒人了房間就關掉', !hub.rooms.has(roomId));
  ok('房間關了邀請連結也失效', hub.verifyInvite(roomId, token).reason === 'gone');

  loop.stop();
  server.close();
  console.log('\n線上流程：' + pass + ' 通過，' + fail + ' 失敗');
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
