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
  let onTrack = 0;
  for (const nd of tr.nodes) if (Tracks.surfaceAt(tr, nd.x, nd.y) !== Tracks.SURFACE.GRASS) onTrack++;
  ok(def.id + ' 中心線整條都在跑道上', onTrack === tr.nodes.length, onTrack + '/' + tr.nodes.length);

  const nd0 = tr.nodes[0];
  ok(def.id + ' 跑道外面是草地',
    Tracks.surfaceAt(tr, nd0.x + nd0.nx * (nd0.w + 45), nd0.y + nd0.ny * (nd0.w + 45)) === Tracks.SURFACE.GRASS);

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
   * 本來是「開直線 vs 一直轉彎，比誰比較快」，但花園小徑的起跑點就在彎道上 ——
   * 開直線的那一隻直接衝進草地，反而比轉彎的慢，測到的是地形不是轉向懲罰。 */
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
  /* 草地比跑道慢。
   * 本來是丟到草地上跑 60 個 tick 再量，但沒有人扶方向盤，
   * 毛毛蟲跑一跑會自己飄回跑道上、速度跟著回滿 —— 量到的是「已經回到路上」。
   * 改成 20 個 tick（掉速只要零點幾秒就到位），而且先確認人還在草地上。 */
  const st = race();
  run(st, 120);
  const onRoad = st.racers[0].speed;
  const nd = st.track.nodes[st.racers[0].node];
  st.racers[0].x = nd.x + nd.nx * (nd.w + 40);
  st.racers[0].y = nd.y + nd.ny * (nd.w + 40);
  run(st, 20);
  ok('丟到草地上真的還在草地上',
    Rules.surfaceFor(st, st.racers[0]) === Tracks.SURFACE.GRASS);
  ok('草地上跑比較慢', st.racers[0].speed < onRoad * 0.85,
    Math.round(st.racers[0].speed) + ' vs ' + Math.round(onRoad));
}

/* ================================================================ */
group('三、蠕動衝刺');

{
  const st = race();
  run(st, 100);
  const r = st.racers[0];
  /* 甜蜜區間內左右交替：每 9 個 tick（0.3 秒）換一次邊 */
  let dir = 1, n = 0;
  for (let i = 0; i < 9 * 5; i++) {
    if (i % 9 === 0) dir = -dir;
    Rules.step(st, { a: { steer: dir, use: false } });
    if (st.events.some(e => e.type === 'wiggle')) n++;
  }
  ok('照節奏左右交替會觸發蠕動衝刺', n >= 1, '觸發 ' + n + ' 次');
}
{
  const st = race();
  run(st, 100);
  /* 亂按：每個 tick 都換邊（0.033 秒），應該永遠不會觸發 */
  let dir = 1, n = 0;
  for (let i = 0; i < 120; i++) {
    dir = -dir;
    Rules.step(st, { a: { steer: dir, use: false } });
    if (st.events.some(e => e.type === 'wiggle')) n++;
  }
  ok('亂按不會觸發蠕動衝刺', n === 0, '觸發 ' + n + ' 次');
  ok('亂按時蠕動槽是空的', st.racers[0].wiggle.beats === 0, st.racers[0].wiggle.beats);
}
{
  const st = race();
  run(st, 100);
  /* 太慢：每 30 個 tick（1 秒）換一次邊，超過 0.55 秒的上限 */
  let dir = 1, n = 0;
  for (let i = 0; i < 30 * 6; i++) {
    if (i % 30 === 0) dir = -dir;
    Rules.step(st, { a: { steer: dir, use: false } });
    if (st.events.some(e => e.type === 'wiggle')) n++;
  }
  ok('換邊太慢不會觸發蠕動衝刺', n === 0, '觸發 ' + n + ' 次');
}
{
  /* 幼幼班門檻比較低：三格就衝 */
  const st = race({ racers: [{ id: 'a', kind: 'human', difficulty: 'baby' }] });
  run(st, 100);
  let dir = 1, n = 0;
  for (let i = 0; i < 9 * 4; i++) {
    if (i % 9 === 0) dir = -dir;
    Rules.step(st, { a: { steer: dir, use: false } });
    if (st.events.some(e => e.type === 'wiggle')) n++;
  }
  ok('幼幼班三格就衝刺', n >= 1, '觸發 ' + n + ' 次');
}
{
  const st = race();
  run(st, 100);
  const base = Rules.speedFactor(st, st.racers[0], Tracks.SURFACE.TRACK, 0);
  st.racers[0].wiggle.until = st.t + 1;
  const boosted = Rules.speedFactor(st, st.racers[0], Tracks.SURFACE.TRACK, 0);
  ok('蠕動衝刺加速 45%', Math.abs(boosted / base - 1.45) < 0.001, (boosted / base).toFixed(3));
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
  run(st, 100);
  const a = st.racers[0];
  ok('一開始身上沒有道具', a.item === null);
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
  ok('結算有統計數字', typeof res[0].stats.wiggleBoosts === 'number');
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

/* ================================================================ */
console.log('\n規則核心：' + pass + ' 通過，' + fail + ' 失敗');
process.exit(fail ? 1 : 0);
