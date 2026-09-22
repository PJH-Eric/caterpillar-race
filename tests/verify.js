/* ===== tests/verify.js — 規則核心的單元測試 =====
 * 只測 rules.js／tracks.js／items.js，不開伺服器、不碰畫面。
 * 每一條都是「規劃書講好的行為」，改規則就要順手改這裡。
 */
'use strict';

const Rules = require('../public/js/rules.js');
const Tracks = require('../public/js/tracks.js');
const Items = require('../public/js/items.js');
const RNG = require('../public/js/rng.js');
const AI = require('../public/js/ai.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  → ' + extra : '')); }
}
function group(name) { console.log('\n' + name); }

function angleDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** 開一局單人測試用的比賽 */
function race(opt) {
  opt = opt || {};
  const track = Tracks.get(opt.track || 'garden', opt.seed || 's');
  return Rules.createRace({
    track: track,
    laps: opt.laps || 1,
    seed: opt.seed || 's',
    allowBad: opt.allowBad !== false,
    racers: opt.racers || [{ id: 'a', name: '甲', kind: 'human' }]
  });
}
/** 跑 n 個 tick，輸入用 fn(state, racer) 產生 */
function run(st, n, fn) {
  for (let i = 0; i < n; i++) {
    const inputs = {};
    for (const r of st.racers) inputs[r.id] = fn ? (fn(st, r) || { steer: 0, use: false }) : { steer: 0, use: false };
    Rules.step(st, inputs);
    if (st.phase === 'finished') break;
  }
  return st;
}
/** 用 AI 幫忙把毛毛蟲開在賽道上 */
function drive(st, n) {
  let i = 0;
  while (i++ < n && st.phase !== 'finished') {
    const inputs = {};
    for (const r of st.racers) {
      const was = r.kind;
      r.kind = 'ai';
      inputs[r.id] = AI.input(st, r);
      r.kind = was;
    }
    Rules.step(st, inputs);
  }
  return st;
}

/* ================================================================ */
group('一、賽道幾何');

for (const def of Tracks.TRACKS) {
  const tr = Tracks.build(def);
  ok(def.id + ' 加速來源只有帶狀路面，沒有露珠加速點',
    tr.boosts.length > 0 && tr.boosts.every(b => b.strip === true));
  let onTrack = 0;
  for (const nd of tr.nodes) if (Tracks.surfaceAt(tr, nd.x, nd.y) !== Tracks.SURFACE.GRASS) onTrack++;
  ok(def.id + ' 中心線整條都在跑道上', onTrack === tr.nodes.length, onTrack + '/' + tr.nodes.length);

  /* 連續彎旁可能是另一段跑道，以世界邊界的草地驗證。 */
  ok(def.id + ' 跑道外面是草地',
    Tracks.surfaceAt(tr, tr.bounds.minX + 20, tr.bounds.minY + 20) === Tracks.SURFACE.GRASS);

  const cps = new Set();
  for (let i = 0; i < tr.nodes.length; i++) cps.add(Tracks.checkpointOf(tr, i));
  ok(def.id + ' 檢查點剛好 ' + Tracks.CHECKPOINTS + ' 個', cps.size === Tracks.CHECKPOINTS, cps.size);

  let bad = 0;
  for (const rk of tr.rocks) {
    for (let i = 0; i < 48; i++) {
      const a = i / 48 * Math.PI * 2;
      if (Tracks.surfaceAt(tr, rk.x + Math.cos(a) * rk.r * 0.8, rk.y + Math.sin(a) * rk.r * 0.8) !== Tracks.SURFACE.GRASS) bad++;
    }
  }
  ok(def.id + ' 石頭沒有壓在跑道上', bad === 0, bad);
  ok(def.id + ' 有八個起跑格', tr.starts.length === 8);
  ok(def.id + ' 起跑格都在跑道上',
    tr.starts.every(s => Tracks.surfaceAt(tr, s.x, s.y) !== Tracks.SURFACE.GRASS));

  const startIndex = tr.startNode === undefined ? tr.starts[0].node : tr.startNode;
  const startNodes = new Set(tr.starts.map(s => s.node));
  ok(def.id + ' 八個選手在同一排起跑線', startNodes.size === 1 && tr.starts[0].node === startIndex,
    Array.from(startNodes).join(','));
  const origin = tr.nodes[startIndex];
  const along = tr.starts.map(s => (s.x - origin.x) * origin.tx + (s.y - origin.y) * origin.ty);
  const lateral = tr.starts.map(s => (s.x - origin.x) * origin.nx + (s.y - origin.y) * origin.ny);
  ok(def.id + ' 起跑線垂直賽道且沒有前後錯位',
    Math.max(...along) - Math.min(...along) < 0.001);
  ok(def.id + ' 起跑席位橫向等距排列',
    lateral.every((v, i) => i === 0 || Math.abs(v - lateral[i - 1] - (lateral[1] - lateral[0])) < 0.001));
  const startAngle = Math.atan2(origin.ty, origin.tx);
  let maxStartTurn = 0;
  for (let d = 0; d <= Tracks.START_STRAIGHT_NODES; d++) {
    const i = Tracks.idx(tr, startIndex + d);
    const a = Math.atan2(tr.nodes[i].ty, tr.nodes[i].tx);
    maxStartTurn = Math.max(maxStartTurn, Math.abs(angleDiff(a, startAngle)));
  }
  ok(def.id + ' 起跑前方保持直線', maxStartTurn < 0.7, maxStartTurn.toFixed(2));
}

{
  const tr = Tracks.get('garden', 'start-order');
  const racers = Array.from({ length: 4 }, (_, i) => ({ id: 'start-' + i, kind: 'human' }));
  const slotOf = seed => Rules.createRace({ track: tr, seed, racers }).racers.map(r =>
    tr.starts.findIndex(s => Math.abs(s.x - r.x) < 0.001 && Math.abs(s.y - r.y) < 0.001));
  const first = slotOf('start-a');
  const second = slotOf('start-b');
  const distances = first.map(slot => Math.abs(slot - 3.5)).sort((a, b) => a - b);
  const centerOwner = slots => slots.findIndex(slot => slot === 3);
  ok('選手起跑位置從中央向兩側排',
    distances.join(',') === '0.5,0.5,1.5,1.5',
    first.join(','));
  ok('中央起跑格由種子隨機分配', centerOwner(first) !== centerOwner(second),
    centerOwner(first) + ' vs ' + centerOwner(second));
}

/* 隨機賽道：同一個 seed 一定長出同一張 */
const r1 = Tracks.get('random', 'abc'), r2 = Tracks.get('random', 'abc'), r3 = Tracks.get('random', 'xyz');
ok('同一個 seed 的隨機賽道完全一樣',
  r1.nodes.length === r2.nodes.length && r1.nodes[10].x === r2.nodes[10].x);
ok('不同 seed 的隨機賽道不一樣', r1.nodes.length !== r3.nodes.length || r1.nodes[10].x !== r3.nodes[10].x);
for (const seed of ['a1', 'b2', 'c3', 'd4', 'e5']) {
  const tr = Tracks.get('random', seed);
  let on = 0;
  for (const nd of tr.nodes) if (Tracks.surfaceAt(tr, nd.x, nd.y) !== Tracks.SURFACE.GRASS) on++;
  ok('隨機賽道 ' + seed + ' 是完整閉環', on === tr.nodes.length, on + '/' + tr.nodes.length);
}

/* ================================================================ */
group('二、基本物理');

{
  const st = race();
  ok('開局是倒數階段', st.phase === 'countdown');
  run(st, 10);
  ok('倒數中不會動', st.racers[0].speed === 0);
  run(st, Math.ceil(Rules.C.COUNTDOWN / Rules.C.TICK) + 2);
  ok('倒數結束就開跑', st.phase === 'racing');
  run(st, 20);
  ok('開跑後會往前', st.racers[0].speed > 40, Math.round(st.racers[0].speed));
}
{
  /* 轉向懲罰要直接比速度公式。
   * 不用實際跑直線與彎道比較，避免把賽道地形、起跑位置混進轉向懲罰的測試。 */
  const st = race();
  run(st, 120);
  const r = st.racers[0];
  const straight = Rules.speedFactor(st, r, Tracks.SURFACE.TRACK, 0);
  const turning = Rules.speedFactor(st, r, Tracks.SURFACE.TRACK, 1);
  ok('轉彎中的速度上限比直線低', turning < straight, turning.toFixed(3) + ' vs ' + straight.toFixed(3));
  ok('轉彎懲罰不超過 12%', turning / straight > 1 - Rules.C.TURN_PENALTY - 0.001);
}
{
  /* 轉向有慣性：同樣按一下，短按轉的角度要明顯小於長按 */
  const a = race(); run(a, 100);
  const a0 = a.racers[0].angle;
  run(a, 4, () => ({ steer: 1, use: false }));
  const shortTurn = Math.abs(a.racers[0].angle - a0);

  const b = race(); run(b, 100);
  const b0 = b.racers[0].angle;
  run(b, 20, () => ({ steer: 1, use: false }));
  const longTurn = Math.abs(b.racers[0].angle - b0);
  ok('轉向有慣性（短按轉得少）', shortTurn * 5 < longTurn,
    shortTurn.toFixed(3) + ' vs ' + longTurn.toFixed(3));
}
{
  /* 終點線：起跑時八隻毛毛蟲並排在線上，第一圈從開跑後的下一個檢查點開始累計。 */
  const st = race({ laps: 2 });
  const r = st.racers[0];
  const CP = st.track.checkpoints;
  ok('起跑格就在終點線（檢查點是第一個）', r.cp === 0, r.cp + '/' + CP);
  ok('開局的檢查點累計從零開始', r.cpCount === 0, r.cpCount);

  let lastCp = r.cp, crossings = [], lapAt = [];
  let lastLap = r.lap, t = 0;
  while (st.phase !== 'finished' && t < 60 * 90) {
    const inputs = {}; inputs[r.id] = AI.input(st, r);
    Rules.step(st, inputs);
    if (lastCp === CP - 1 && r.cp === 0) crossings.push(+st.raceT.toFixed(2));
    if (r.lap > lastLap) { lapAt.push(+st.raceT.toFixed(2)); lastLap = r.lap; }
    lastCp = r.cp; t++;
  }
  ok('繞完兩圈越線兩次', crossings.length === 2, crossings.join(','));
  ok('每一圈都剛好在越線那一刻進位',
    lapAt.length === 2 && lapAt[0] === crossings[0] && lapAt[1] === crossings[1],
    '進位 ' + lapAt.join(',') + ' vs 越線 ' + crossings.join(','));
  ok('完賽時間等於最後一次越線', Math.abs(r.finishTime - crossings[1]) < 0.02,
    r.finishTime.toFixed(2) + ' vs ' + crossings[1]);
}
{
  /* 第一名衝線後開始倒數，時間到就收局，還沒到終點的人算沒跑完 */
  const st = race({ laps: 2, racers: [
    { id: 'a', name: '快', kind: 'ai', difficulty: 'hard' },
    { id: 'b', name: '慢', kind: 'ai', difficulty: 'baby' }
  ] });
  ok('開局還沒有收局時間', st.graceEnd === 0);
  drive(st, 60 * 180);
  ok('第一名完賽後才設收局時間', st.graceEnd > st.firstFinishAt, st.graceEnd.toFixed(1));
  ok('倒數剛好是 FINISH_GRACE 秒',
    Math.abs((st.graceEnd - st.firstFinishAt) - Rules.C.FINISH_GRACE) < 0.001,
    (st.graceEnd - st.firstFinishAt).toFixed(3));
  ok('收局不會晚於倒數結束', st.raceT <= st.graceEnd + Rules.C.TICK + 0.001,
    st.raceT.toFixed(2) + ' vs ' + st.graceEnd.toFixed(2));
  ok('倒數內沒到終點的人算沒跑完',
    st.racers.every(r => r.finished || r.finishTime >= st.graceEnd - 0.001));
}
{
  /* 草地比跑道慢。
   * 本來是丟到草地上跑 60 個 tick 再量，但沒有人扶方向盤，
   * 毛毛蟲跑一跑會自己飄回跑道上、速度跟著回滿 —— 量到的是「已經回到路上」。
   * 改成 20 個 tick（掉速只要零點幾秒就到位），而且先確認人還在草地上。 */
  const st = race();
  run(st, 120);
  const onRoad = st.racers[0].speed;
  st.racers[0].x = st.track.bounds.minX + 35;
  st.racers[0].y = st.track.bounds.minY + 35;
  st.racers[0].angle = 0;
  run(st, 20);
  ok('丟到草地上真的還在草地上',
    Rules.surfaceFor(st, st.racers[0]) === Tracks.SURFACE.GRASS);
  ok('草地上跑比較慢', st.racers[0].speed < onRoad * 0.85,
    Math.round(st.racers[0].speed) + ' vs ' + Math.round(onRoad));
}

/* ================================================================ */
group('三、油門與速度');

{
  const st = race();
  run(st, 100);
  const r = st.racers[0];
  /* 按住前進就是「基礎速度乘上腳下的地形係數」，沒有任何隱藏加成。
   * 不能直接比 BASE_SPEED —— 賽道上現在有速度帶與水坑，跑一百 tick 之後
   * 人在哪一種地形上是賽道決定的。 */
  for (let i = 0; i < 90; i++) {
    /* 速度帶是「踩過去之後還會持續一段時間」的加成：帶子變短之後，人可能已經
     * 離開帶子但加成還沒退。這一題只想量「腳下地形」的速度，所以把計時中的
     * 加成與減速都清掉再量。 */
    r.padUntil = 0; r.juiceUntil = 0; r.slowUntil = 0;
    Rules.step(st, { a: { steer: 0, gas: 1, man: 1, use: false } });
  }
  r.padUntil = 0; r.juiceUntil = 0; r.slowUntil = 0;
  const surf = Rules.surfaceFor(st, r);
  const want = Rules.C.BASE_SPEED * Rules.C.SURFACE_SPEED[surf];
  ok('按住前進會加速到該地形的基礎速度', Math.abs(r.speed - want) < 3,
    r.speed.toFixed(1) + ' / 應為 ' + want.toFixed(1) + '（地形 ' + surf + '）');
}
{
  const st = race();
  run(st, 100);
  const r = st.racers[0];
  /* 左右交替按只會轉向，不會多出速度 —— 蠕動衝刺已經移除 */
  let dir = 1, peak = 0;
  for (let i = 0; i < 9 * 8; i++) {
    if (i % 9 === 0) dir = -dir;
    Rules.step(st, { a: { steer: dir, gas: 1, man: 1, use: false } });
    peak = Math.max(peak, r.speed);
  }
  /* 上限用加速帶算：交替轉向只能證明「沒有多出速度」。 */
  const cap = Rules.C.BASE_SPEED * (1 + Rules.C.MAX_BOOST) + 1;
  ok('左右交替按不會扭出額外速度', peak <= cap, peak.toFixed(1) + ' / 上限 ' + cap.toFixed(1));
  ok('沒有 wiggle 事件了', !st.events.some(e => e.type === 'wiggle'));
}
{
  const st = race();
  run(st, 100);
  const straight = Rules.speedFactor(st, st.racers[0], Tracks.SURFACE.TRACK, 0);
  const turning = Rules.speedFactor(st, st.racers[0], Tracks.SURFACE.TRACK, 1);
  ok('轉向中會稍微慢一點', turning < straight, (turning / straight).toFixed(3));
}
{
  const st = race();
  run(st, 100);
  const base = Rules.speedFactor(st, st.racers[0], Tracks.SURFACE.TRACK, 0);
  st.racers[0].padUntil = st.t + 1;
  const boosted = Rules.speedFactor(st, st.racers[0], Tracks.SURFACE.TRACK, 0);
  ok('加速帶加速 60%', Math.abs(boosted / base - 1.6) < 0.001, (boosted / base).toFixed(3));
}
{
  /* 統計欄位換掉之後，結算頁抓的欄位要都還在 */
  const st = race();
  const s2 = st.racers[0].stats;
  ok('統計不再有蠕動衝刺次數', s2.wiggleBoosts === undefined);
  ok('統計仍有加速帶、道具、撞牆、出界', ['pads', 'itemsUsed', 'itemHits', 'hits', 'offTrack']
    .every(k => typeof s2[k] === 'number'));
}

/* ================================================================ */
group('四、計圈與檢查點');

{
  const st = race({ laps: 2 });
  drive(st, 30 * 120);
  ok('AI 開得完兩圈', st.racers[0].finished, st.racers[0].lap + ' 圈');
  ok('完成圈數正好等於設定', st.racers[0].lap === 2, st.racers[0].lap);
  ok('每一圈都有記時間', st.racers[0].lapTimes.length === 2, st.racers[0].lapTimes.length);
  ok('單圈時間合理（都大於 3 秒）', st.racers[0].lapTimes.every(t => t > 3));
}
{
  /* 倒車不會多算圈數 */
  const st = race({ laps: 1 });
  run(st, Math.ceil(Rules.C.COUNTDOWN / Rules.C.TICK) + 2);
  const r = st.racers[0];
  const N = st.trackNodes;
  /* 直接把毛毛蟲瞬移到終點線前後來回，跳過中間的檢查點 */
  for (let k = 0; k < 6; k++) {
    for (const idx of [N - 3, 2]) {
      const nd = st.track.nodes[idx];
      r.x = nd.x; r.y = nd.y; r.node = idx;
      Rules.step(st, { a: { steer: 0, use: false } });
    }
  }
  ok('在終點線前後來回不會刷圈', r.lap === 0, r.lap);
}
{
  /* 跳過一半賽道不算完成 */
  const st = race({ laps: 1 });
  run(st, Math.ceil(Rules.C.COUNTDOWN / Rules.C.TICK) + 2);
  const r = st.racers[0];
  const N = st.trackNodes;
  for (const idx of [0, Math.floor(N * 0.5), 0]) {
    const nd = st.track.nodes[idx];
    r.x = nd.x; r.y = nd.y; r.node = idx;
    Rules.step(st, { a: { steer: 0, use: false } });
  }
  ok('跳過半條賽道不算完成一圈', !r.finished && r.lap === 0, r.lap + '/' + r.finished);
}

/* ================================================================ */
group('五、道具');

{
  const rng = RNG.create('x');
  const counts = {};
  for (let i = 0; i < 3000; i++) {
    const id = Items.draw(rng, 6, 6, false);
    counts[id] = (counts[id] || 0) + 1;
  }
  ok('關掉負面道具就只會抽到好道具',
    Object.keys(counts).every(id => Items.ITEMS[id].kind === 'good'), JSON.stringify(counts));
}
{
  /* 橡皮筋分配：看的是「抽到什麼」，不是「好壞比例」——
   * 第一名與最後一名的好壞比例剛好都是 45%，只比總數會看不出差別。 */
  const rng = RNG.create('y');
  const lead = {}, back = {};
  for (let i = 0; i < 4000; i++) {
    const a = Items.draw(rng, 1, 6, true); lead[a] = (lead[a] || 0) + 1;
    const b = Items.draw(rng, 6, 6, true); back[b] = (back[b] || 0) + 1;
  }
  ok('縮小咒只發給落後的人', !lead.tiny && back.tiny > 300, (lead.tiny || 0) + ' vs ' + (back.tiny || 0));
  ok('第一名比較容易抽到黏液（只能守不能攻）', lead.goo > back.goo * 3, lead.goo + ' vs ' + back.goo);
  ok('落後的人比較容易抽到果汁加速', back.juice > lead.juice * 2, back.juice + ' vs ' + lead.juice);
}
{
  /* 泡泡護盾擋一次負面效果，擋完就破 */
  const st = race({ racers: [{ id: 'a', kind: 'human' }, { id: 'b', kind: 'human' }] });
  run(st, 100);
  const a = st.racers[0];
  a.shieldUntil = st.t + 10;
  const hit = Rules.applySlow(st, a, 1.5, 0.5, st.racers[1]);
  ok('護盾擋下負面效果', hit === false);
  ok('擋完護盾就破', a.shieldUntil === 0);
  const hit2 = Rules.applySlow(st, a, 1.5, 0.5, st.racers[1]);
  ok('護盾破了就擋不住第二次', hit2 === true);
  ok('中招之後真的變慢', a.slowUntil > st.t && a.slowPower === 0.5);
}
{
  /* 葉子小飛期間無視地形與負面效果 */
  const st = race();
  run(st, 100);
  const a = st.racers[0];
  a.hopUntil = st.t + 5;
  ok('飄浮時地形一律當成跑道', Rules.surfaceFor(st, a) === Tracks.SURFACE.TRACK);
  ok('飄浮時躲得掉負面效果', Rules.applySlow(st, a, 1.5, 0.5, null) === false);
}
{
  /* 蜘蛛絲只打得到前面的人 */
  const st = race({ racers: [{ id: 'a', kind: 'human' }, { id: 'b', kind: 'human' }] });
  run(st, 100);
  const a = st.racers[0], b = st.racers[1];
  a.progress = 10; b.progress = 30;
  ok('找得到前面的人', Rules.nearestAhead(st, a, 9000) === b);
  ok('前面沒人就打不到', Rules.nearestAhead(st, b, 9000) === null);
}
{
  /* 撞到道具葉才會拿到道具 */
  const st = race();
  const a = st.racers[0];
  ok('一開始身上沒有道具', a.item === null);
  run(st, 100);
  /* 起跑席位現在每局隨機，測試碰葉子前把場上的葉子重置，避免剛好路過時先撿到。 */
  a.item = null;
  for (const l of st.leaves) l.readyAt = 0;
  const leaf = st.leaves[0];
  a.x = leaf.x; a.y = leaf.y;
  Rules.step(st, { a: { steer: 0, use: false } });
  ok('撞到道具葉就拿到道具', !!a.item, String(a.item));
  ok('道具葉被吃掉會進入重生冷卻', st.leaves[0].readyAt > st.t);
  const held = a.item;
  Rules.step(st, { a: { steer: 0, use: true } });
  ok('用掉道具之後手上就空了', a.item === null, String(held));
}

/* ================================================================ */
group('六、勝負與結算');

{
  const st = race({
    laps: 1,
    racers: [{ id: 'a', kind: 'human' }, { id: 'b', kind: 'human' }, { id: 'c', kind: 'human' }]
  });
  drive(st, 30 * 120);
  ok('比賽會結束', st.phase === 'finished');
  const res = Rules.results(st);
  ok('名次是 1、2、3 沒有重複', res.map(r => r.rank).join() === '1,2,3', res.map(r => r.rank).join());
  ok('第一名的完成時間最短',
    res[0].time <= res[1].time && res[1].time <= res[2].time,
    res.map(r => r.time).join(' / '));
  ok('結算有統計數字', typeof res[0].stats.pads === 'number' && typeof res[0].stats.hits === 'number');
}
{
  /* 幽靈不參與碰撞也不會動，而且排名排在後面 */
  const st = race({ racers: [{ id: 'a', kind: 'human' }, { id: 'b', kind: 'human' }] });
  run(st, 120);
  Rules.markGhost(st, 'b', true);
  const b = st.racers[1];
  const bx = b.x, by = b.y;
  run(st, 60);
  ok('幽靈化之後就不動了', b.x === bx && b.y === by);
  ok('幽靈排在還在跑的人後面', st.racers[0].rank < b.rank);
  Rules.markGhost(st, 'b', false);
  run(st, 30);
  ok('接回來之後又會動', st.racers[1].ghost === false);
}
{
  /* 全部人都完賽，比賽就結束 */
  const st = race({ laps: 1, racers: [{ id: 'a', kind: 'human' }, { id: 'b', kind: 'human' }] });
  run(st, 120);
  Rules.markGhost(st, 'a', true);
  Rules.markGhost(st, 'b', true);
  run(st, 5);
  ok('沒人在跑就直接收局', st.phase === 'finished');
}

/* ================================================================ */
group('七、重現性');

{
  function play(seed) {
    const st = race({ seed: seed, laps: 1, racers: [{ id: 'a', kind: 'ai', difficulty: 'hard' }] });
    drive(st, 30 * 120);
    return st.racers[0].finishTime + '|' + st.racers[0].stats.itemsUsed + '|' + st.racers[0].x.toFixed(4);
  }
  ok('同一個 seed 跑出完全一樣的結果', play('same') === play('same'));
  ok('不同 seed 結果不一樣', play('one') !== play('two'));
}
{
  const snap = Rules.snapshot(race());
  ok('快照有必要的欄位', 'racers' in snap && 'goo' in snap && 'leaves' in snap && 'phase' in snap);
  ok('快照裡每個人都有名次與圈數',
    snap.racers.every(r => 'rank' in r && 'lap' in r && 'item' in r));
}

group('八、賽道機制（水坑、加速帶、減速帶）');
{
  const S = Tracks.SURFACE;
  /* --- 地形係數的相對關係。數值可以調，關係不能壞掉。 --- */
  const SP = Rules.C.SURFACE_SPEED, GRIP = Rules.C.GRIP;
  ok('減速帶比平路慢，但比泥巴好過', SP[S.SLOW] < SP[S.TRACK] && SP[S.SLOW] > SP[S.MUD]);
  ok('水坑比平路慢，但比泥巴好過', SP[S.WATER] < SP[S.TRACK] && SP[S.WATER] > SP[S.MUD]);
  ok('水坑比泥巴滑很多', GRIP[S.WATER] > GRIP[S.MUD] * 3, GRIP[S.WATER] + ' vs ' + GRIP[S.MUD]);
  ok('水坑比草地還滑', GRIP[S.WATER] > GRIP[S.GRASS]);
  ok('速度帶不改抓地力', GRIP[S.BOOST] === GRIP[S.TRACK] && GRIP[S.SLOW] === GRIP[S.TRACK]);
  ok('每一種地形都有速度係數與抓地力',
    Object.keys(S).every(k => SP[S[k]] !== undefined && GRIP[S[k]] !== undefined));
}
{
  /* --- 真的把毛毛蟲放到各種地形上，看速度收斂到哪 --- */
  const S = Tracks.SURFACE;
  function cruiseOn(surface) {
    const track = Tracks.get('garden', 's');
    const st = Rules.createRace({ track: track, laps: 1, seed: 's',
      racers: [{ id: 'a', kind: 'human' }] });
    const r = st.racers[0];
    /* 把整張賽道的地形改成指定的那一種，人就一定站在上面 */
    track.grid.surface.fill(surface);
    /* 120 tick 足夠收斂到目標速度，也避免提速後提前衝到終點開始減速。 */
    for (let i = 0; i < 120; i++) Rules.step(st, { a: { steer: 0, gas: 1, man: 1, use: false } });
    return r.speed;
  }
  const flat = cruiseOn(S.TRACK);
  ok('減速帶上真的開比較慢', cruiseOn(S.SLOW) < flat * 0.75, cruiseOn(S.SLOW).toFixed(0) + ' vs ' + flat.toFixed(0));
  ok('水坑裡開比較慢', cruiseOn(S.WATER) < flat * 0.8);
}
{
  /* --- 踏進水坑會發事件，而且只在「踏進去」那一刻發一次 --- */
  const S = Tracks.SURFACE;
  const track = Tracks.get('garden', 's');
  const st = Rules.createRace({ track: track, laps: 1, seed: 's',
    racers: [{ id: 'a', kind: 'human' }] });
  /* 先跑過倒數：倒數期間 step 根本不會走到地形那一段 */
  run(st, 120);
  track.grid.surface.fill(S.WATER);
  let splashes = 0;
  for (let i = 0; i < 90; i++) {
    Rules.step(st, { a: { steer: 0, gas: 1, man: 1, use: false } });
    splashes += st.events.filter(e => e.type === 'splash').length;
  }
  ok('踩進水坑會發 splash 事件', splashes >= 1, splashes);
  ok('待在水坑裡不會每一 tick 都發事件', splashes === 1, splashes + ' 次');
  ok('水坑有記進統計', st.racers[0].stats.splash > 1);
}
{
  /* --- 每張賽道都要有速度帶，且不再產生坡或捷徑 --- */
  const noFeature = [], outOfRange = [], oldMechanism = [];
  for (const def of Tracks.TRACKS) {
    const t = Tracks.build(def);
    if (!t.boosts.length || !t.slowdowns.length) noFeature.push(def.id);
    for (const sp of t.strips) {
      if (sp.from < 0 || sp.to <= sp.from || (t.open && sp.to > t.nodes.length)) outOfRange.push(def.id);
    }
    if (t.slopes || t.shortcuts || t.slopeAt) oldMechanism.push(def.id);
  }
  ok('每張賽道都有加速帶與減速帶', noFeature.length === 0, noFeature.join(', '));
  ok('速度帶區間都在賽道範圍內', outOfRange.length === 0, outOfRange.join(', '));
  ok('賽道不再包含上下坡或捷徑機制', oldMechanism.length === 0, oldMechanism.join(', '));
}
{
  /* --- 同一個 seed 一定長出一樣的賽道（線上對戰兩邊要算出同一張） --- */
  const a = Tracks.get('random', 'same-seed');
  const b = Tracks.get('random', 'same-seed');
  const key = t => JSON.stringify([t.strips, t.slowdowns, t.water.map(w => [w.x | 0, w.y | 0])]);
  ok('同一個 seed 的機制佈局完全一樣', key(a) === key(b));
  const c = Tracks.get('random', 'other-seed');
  ok('不同 seed 的機制佈局不一樣', key(a) !== key(c));
}

{
  /* --- 兩塊牌子不能擠在一起 ---
   * 連著三塊牌子閃過去，玩家一塊都讀不到，等於沒有牌子。
   * 每一種機制是各自挑位置的，所以不同種類本來就會撞在一起 ——
   * 疏開之前實測有四對站在同一個節點上、一百一十五對間隔不到 20 個節點。 */
   const GAP = 40;                    /* 約 560 單位，以基礎速度跑過去約 3.7 秒 */
  const tooClose = [], dup = [];
  let minGap = Infinity;

  for (const def of Tracks.TRACKS) {
    const t = Tracks.build(def);
    const n = t.nodes.length;
    const ns = t.signs.slice().sort((a, b) => a.node - b.node);
    for (let i = 1; i < ns.length; i++) {
      const gap = ns[i].node - ns[i - 1].node;
      minGap = Math.min(minGap, gap);
      if (gap < GAP) tooClose.push(def.id + '@' + ns[i].node + ' 只隔 ' + gap);
      if (gap === 0) dup.push(def.id + '@' + ns[i].node);
    }
    /* 環形賽道的頭尾也是鄰居 */
    if (!t.open && ns.length > 1) {
      const gap = n - ns[ns.length - 1].node + ns[0].node;
      minGap = Math.min(minGap, gap);
      if (gap < GAP) tooClose.push(def.id + ' 頭尾只隔 ' + gap);
    }
  }

  ok('沒有兩塊牌子站在同一個節點上', dup.length === 0, dup.slice(0, 3).join(', '));
  ok('任兩塊牌子都隔得夠開（含環形賽道的頭尾）', tooClose.length === 0,
    tooClose.length + ' 對太近：' + tooClose.slice(0, 3).join('; '));
  ok('最近的兩塊也隔得夠開', minGap >= GAP, '最近 ' + minGap + ' 個節點');
  ok('彎道標誌比地形標誌更早出現', Tracks.SIGN_LEAD_TURN > Tracks.SIGN_LEAD_FEATURE,
    Tracks.SIGN_LEAD_TURN + ' vs ' + Tracks.SIGN_LEAD_FEATURE);
  ok('標誌間距大於彎道提前距離', Tracks.SIGN_MIN_GAP > Tracks.SIGN_LEAD_TURN,
    Tracks.SIGN_MIN_GAP + ' vs ' + Tracks.SIGN_LEAD_TURN);

  /* 擠在一起時要留「不知道代價最大」的那一種：路型 > 水坑 > 減速帶。
   * 這條保證疏開不是隨便砍，而是有取捨的。 */
  const RANK = ['sturn', 'left', 'right', 'slow', 'water', 'boost'];
  const seen = {};
  for (const def of Tracks.TRACKS) {
    for (const sg of Tracks.build(def).signs) seen[sg.kind] = (seen[sg.kind] || 0) + 1;
  }
  ok('疏開之後六種標誌還是都有（不是把某一種全砍光）',
    RANK.every(k => seen[k] > 0), RANK.filter(k => !seen[k]).join(', '));
  /* 路型的牌子留得最多 —— 它排在優先序最前面 */
  const shape = (seen.sturn || 0) + (seen.left || 0) + (seen.right || 0);
  ok('路型的牌子有保留（優先序有生效）', shape > 0, '路型 ' + shape);
  ok('沒有暫時種類漏到外面', !seen.turn, seen.turn);
}

group('九、城市賽道');
{
  const CITY = ['city', 'highway', 'cityNight'];
  const city = Tracks.TRACKS.filter(t => CITY.indexOf(t.theme) >= 0);
  ok('城市有五張賽道', city.length === 5, city.length);
  ok('三張有圈數', city.filter(t => !t.open).length === 3, city.filter(t => !t.open).length);
  ok('兩張沒有圈數（衝刺）', city.filter(t => t.open).length === 2, city.filter(t => t.open).length);
  const hw = Tracks.BY_ID.expressway;
  ok('有一張高速公路', !!hw && hw.theme === 'highway');
  ok('高速公路是兩圈', hw && hw.laps === 2, hw && hw.laps);
  ok('高速公路是有圈數的那種', hw && !hw.open);
  /* 高速公路要真的比較寬 —— 不然叫高速公路只是換個名字 */
  const wide = id => {
    const t = Tracks.get(id);
    return t.nodes.reduce((a, b) => a + b.w, 0) / t.nodes.length;
  };
  ok('高速公路比市中心寬', wide('expressway') > wide('downtown'),
    wide('expressway').toFixed(0) + ' vs ' + wide('downtown').toFixed(0));
  ok('城市賽道都在「城市」那一頁', city.every(t => Tracks.groupOf(t) === 'city'));
  ok('每張城市賽道都跑得完', city.every(def => {
    const track = Tracks.build(def);
    const st = Rules.createRace({ track: track, laps: track.laps, seed: 's',
      racers: [{ id: 'a', kind: 'ai', difficulty: 'normal' }] });
    let n = 0;
    while (st.phase !== 'finished' && n < 30 * 400) { Rules.step(st, AI.inputsFor(st)); n++; }
    return st.racers[0].finished;
  }));
}

group('十、交通標誌');
{
  const KINDS = ['left', 'right', 'sturn', 'boost', 'slow', 'water'];
  const seen = {}, problems = [];
  let total = 0, minPer = 1e9, maxPer = 0;

  for (const def of Tracks.TRACKS) {
    const t = Tracks.build(def);
    const n = t.nodes.length;
    total += t.signs.length;
    minPer = Math.min(minPer, t.signs.length);
    maxPer = Math.max(maxPer, t.signs.length);

    for (const sg of t.signs) {
      seen[sg.kind] = (seen[sg.kind] || 0) + 1;
      if (KINDS.indexOf(sg.kind) < 0) problems.push(def.id + ' 有不認得的標誌 ' + sg.kind);
      /* 一定要在路面外 —— 立在路中央會變成障礙物的錯覺 */
      if (Tracks.surfaceAt(t, sg.x, sg.y) !== Tracks.SURFACE.GRASS) {
        problems.push(def.id + ' 的 ' + sg.kind + ' 標誌立在路面上');
      }
      /* 一定要在世界範圍內，不然畫不出來 */
      if (sg.x < t.bounds.minX || sg.x > t.bounds.maxX ||
          sg.y < t.bounds.minY || sg.y > t.bounds.maxY) {
        problems.push(def.id + ' 的標誌在世界範圍外');
      }
      if (!(sg.node >= 0 && sg.node < n)) problems.push(def.id + ' 標誌的節點超出範圍');
    }

  }

  ok('每張賽道都有交通標誌', minPer > 0, '最少的一張只有 ' + minPer + ' 塊');
  ok('標誌數量不會多到變成雜訊', maxPer <= 20, '最多的一張有 ' + maxPer + ' 塊');
  ok('六種標誌全都有用到', KINDS.every(k => seen[k] > 0),
    KINDS.filter(k => !seen[k]).join(', '));
  ok('標誌都立在路面外、世界範圍內，而且不在它要警告的東西上面',
    problems.length === 0, problems.slice(0, 3).join('; '));
  ok('全部賽道加起來有足夠的標誌', total > 150, total + ' 塊');
}
{
  /* 左右轉標誌「指對方向」是這組標誌裡唯一指錯會害到玩家的地方，
   * 但它驗不了 —— 玩家看到的左右是「投影到畫面之後」的左右，
   * 跟世界座標的外積正負是鏡像的（這裡的投影讓世界 +y 落在畫面右邊）。
   * 拿外積來比會跟產生它的程式碼犯同一個錯，測試跟著一起過。
   * 所以那一條搬到 render-check，用 Render.projector 量畫面上的偏移。 */
  ok('每一種標誌都指得出方向或狀態',
    Tracks.TRACKS.every(def => Tracks.build(def).signs.every(sg =>
    ['left', 'right', 'sturn', 'boost', 'slow', 'water'].indexOf(sg.kind) >= 0)));
}
{
  /* 同一個 seed 的標誌要一模一樣（線上對戰兩邊看到的牌子必須相同） */
  const key = t => JSON.stringify(t.signs.map(s => [s.kind, s.node, s.x | 0, s.y | 0]));
  ok('同一個 seed 的標誌完全一樣',
    key(Tracks.get('random', 'sign-seed')) === key(Tracks.get('random', 'sign-seed')));
  ok('隨機賽道也有標誌', Tracks.get('random', 'sign-seed').signs.length > 0);
}

group('十一、擺動幅度（左右修方向時畫面擺多大）');
{
  const C = Rules.C;
  /* 鏡頭鎖在車頭上，所以「畫面擺多大」就是「車頭擺多大」。
   * 決定它的是 TURN_ACCEL（角加速度）而不是 TURN（角速度上限）——
   * 快速左右點放的時候車頭根本來不及到滿舵，上限完全沒有參與。
   * 這一條是實測結論：TURN 3.15 → 2.35 擺幅完全沒變（58.2 度），
   * TURN_ACCEL 8.5 → 4.5 才把它砍到 30.9 度。 */

  /** 在直線上以 halfTicks 為半週期左右交替打方向，回傳車頭的峰對峰擺幅（弧度） */
  function swayOf(halfTicks) {
    const st = race();
    run(st, 120);
    const r = st.racers[0];
    const a0 = r.angle;
    let dir = 1, lo = Infinity, hi = -Infinity;
    for (let i = 0; i < halfTicks * 8; i++) {
      if (i % halfTicks === 0) dir = -dir;
      Rules.step(st, { a: { steer: dir, gas: 1, man: 1, use: false } });
      if (i > halfTicks * 2) {
        const d = angleDiff(r.angle, a0);
        lo = Math.min(lo, d); hi = Math.max(hi, d);
      }
    }
    return hi - lo;
  }

  const deg = r => r * 180 / Math.PI;
  const fast = deg(swayOf(3));    /* 0.1 秒一次，快速點放 */
  const mid = deg(swayOf(6));     /* 0.2 秒一次 */

  ok('快速點放時畫面擺幅夠小', fast < 9, fast.toFixed(1) + ' 度');
  ok('一般左右修方向時畫面擺幅夠小', mid < 36, mid.toFixed(1) + ' 度');

  ok('轉向慣性不會太靈敏（太靈敏一甩就轉一大塊）', C.TURN_ACCEL <= 5.0, C.TURN_ACCEL);
  /* 也不能太鈍：實測 3.5 會有一張賽道過不了彎 */
  ok('轉向慣性還夠過彎', C.TURN_ACCEL >= 4.0, C.TURN_ACCEL);
  /* 回正要比打方向快，鬆手才會自己打直、殘餘的擺動收得掉 */
  ok('回正比打方向快', C.TURN_RELEASE > C.TURN_ACCEL,
    C.TURN_RELEASE + ' vs ' + C.TURN_ACCEL);
  ok('滿舵時間在合理範圍（0.4～0.7 秒，有重量但不遲鈍）',
    C.TURN / C.TURN_ACCEL > 0.4 && C.TURN / C.TURN_ACCEL < 0.7,
    (C.TURN / C.TURN_ACCEL).toFixed(2) + ' 秒');
}

group('十二、線上預測（predicted 模式）');
{
  /* 前端跑的是同一份 rules.js，但它只能預測「物理」——
   * 圈數與完賽是權威資料，不能自己算。
   *
   * 原本會自己算，而且算錯：本地的 cpCount 是從 cp 的變化累加出來的，
   * 但 cp 每 67ms 會被快照蓋成「延遲前的值」，同一個檢查點就被重複計算。
   * 實測三圈的比賽裡 HUD 圈數變動了 599 次（應該只有 2 次），
   * 延遲大一點還會長出 92 個假圈數。 */
  function twin(laps) {
    const track = Tracks.get('garden');
    const opt = {
      track: track, laps: laps, seed: 's', allowBad: false,
      racers: [{ id: 'a', kind: 'ai', difficulty: 'normal' }]
    };
    return {
      srv: Rules.createRace(opt),
      cli: Rules.createRace(Object.assign({}, opt, { predicted: true }))
    };
  }

  const t = twin(2);
  ok('predicted 會記在 state 上', t.cli.predicted === true && t.srv.predicted === false);

  /* 兩邊餵一樣的輸入跑完整場：伺服器會完賽，預測那一份不會自己完賽 */
  let n = 0;
  while (t.srv.phase !== 'finished' && n < 30 * 300) {
    const inp = AI.inputsFor(t.srv);
    const one = inp.a || { steer: 0, gas: 1, use: false };
    Rules.step(t.srv, { a: one });
    Rules.step(t.cli, { a: one });
    t.cli.events.length = 0;
    n++;
  }
  const sr = t.srv.racers[0], cr = t.cli.racers[0];
  ok('伺服器那一份會算圈數', sr.lap >= 2, sr.lap);
  ok('伺服器那一份會完賽', sr.finished);
  ok('預測那一份不自己算圈數（等快照）', cr.lap === 0, cr.lap);
  ok('預測那一份不自己完賽（等快照）', !cr.finished);
  ok('預測那一份不自己累加檢查點', cr.cpCount === 0, cr.cpCount);
  ok('預測那一份不發圈數／完賽事件',
    !t.cli.events.some(e => e.type === 'lap' || e.type === 'finish'));
  /* 但物理要照跑，不然畫面就不是預測而是靜止 */
  ok('預測那一份的物理照跑（位置有動）',
    Math.hypot(cr.x - t.cli.starts0x, cr.y - t.cli.starts0y) !== 0 || cr.speed > 0);
  ok('預測那一份還是會更新 node（畫面要用它決定從哪段畫路）', cr.node > 0, cr.node);
  /* 兩邊的位置不該差太多 —— 差很多表示物理在預測模式下被改壞了 */
  ok('預測與權威的位置大致一致', Math.hypot(sr.x - cr.x, sr.y - cr.y) < 200,
    Math.hypot(sr.x - cr.x, sr.y - cr.y).toFixed(0));

  /* 衝刺賽道的完賽條件吃 cpCount，所以也要確認預測模式不會自己完賽 */
  const sprint = Rules.createRace({
    track: Tracks.get('riverrun'), laps: 1, seed: 's', allowBad: false, predicted: true,
    racers: [{ id: 'a', kind: 'ai', difficulty: 'normal' }]
  });
  let m = 0;
  while (m < 30 * 200) { Rules.step(sprint, AI.inputsFor(sprint)); sprint.events.length = 0; m++; }
  ok('衝刺賽道的預測那一份也不自己完賽', !sprint.racers[0].finished);
}

group('十三、速度顯示（km/h）');
{
  const C = Rules.C;
  ok('有定義世界單位對應的公尺數', typeof C.UNIT_M === 'number' && C.UNIT_M > 0, C.UNIT_M);
  /* km/h = 單位／秒 × 公尺／單位 × 3.6 */
  ok('換算公式正確', Math.abs(Rules.kmh(100) - 100 * C.UNIT_M * 3.6) < 1e-9);
  ok('零就是零', Rules.kmh(0) === 0);
  ok('倒退顯示正值（儀表不顯示負速度）', Rules.kmh(-100) === Rules.kmh(100));
  ok('沒給值也不會炸', Rules.kmh() === 0 && Rules.kmh(undefined) === 0);

  /* 讀數要落在賽車該有的範圍 —— 尺度訂錯的話會變成 5 km/h 或 500 km/h */
  const base = Rules.kmh(C.BASE_SPEED);
  ok('基礎速度約為 75 km/h', Math.abs(base - 75) < 1, base.toFixed(0) + ' km/h');
  const top = Rules.kmh(C.BASE_SPEED * (1 + C.MAX_BOOST));
  ok('極速的讀數不誇張（90～200 km/h）', top > 90 && top < 200, top.toFixed(0) + ' km/h');
  ok('泥巴比跑道慢得看得出來',
    Rules.kmh(C.BASE_SPEED * C.SURFACE_SPEED[Tracks.SURFACE.MUD]) < base * 0.6);

  /* 這個值只影響顯示。改它不該動到任何物理。 */
  const before = (() => {
    const st = race();
    run(st, 300, () => ({ steer: 0, gas: 1, man: 1, use: false }));
    return [st.racers[0].x, st.racers[0].y, st.racers[0].speed];
  })();
  const saved = C.UNIT_M;
  C.UNIT_M = saved * 7;
  const after = (() => {
    const st = race();
    run(st, 300, () => ({ steer: 0, gas: 1, man: 1, use: false }));
    return [st.racers[0].x, st.racers[0].y, st.racers[0].speed];
  })();
  C.UNIT_M = saved;
  ok('UNIT_M 只影響顯示，不影響物理',
    Math.abs(before[0] - after[0]) < 1e-9 && Math.abs(before[2] - after[2]) < 1e-9);
}

/* ================================================================ */
console.log('\n規則核心：' + pass + ' 通過，' + fail + ' 失敗');
process.exit(fail ? 1 : 0);
