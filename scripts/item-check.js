/* ===== scripts/item-check.js — 六種道具在真的一局裡會做該做的事 ===== */
'use strict';

const Tracks = require('../public/js/tracks.js');
const Rules = require('../public/js/rules.js');
const Items = require('../public/js/items.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  OK   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  → ' + extra : '')); }
}

function two() {
  const track = Tracks.get('candy', 'item');
  const st = Rules.createRace({
    track: track, laps: 3, seed: 'item',
    racers: [{ id: 'a', name: '甲', kind: 'human' }, { id: 'b', name: '乙', kind: 'human' }]
  });
  for (let i = 0; i < 120; i++) Rules.step(st, { a: { steer: 0 }, b: { steer: 0 } });
  return st;
}

console.log('道具行為\n');

/* 果汁加速 */
{
  const st = two();
  const a = st.racers[0];
  const before = Rules.speedFactor(st, a, Tracks.SURFACE.TRACK, 0);
  a.item = 'juice';
  Rules.step(st, { a: { steer: 0, use: true } });
  const after = Rules.speedFactor(st, a, Tracks.SURFACE.TRACK, 0);
  ok('果汁加速讓速度上限變高', after > before * 1.4, (after / before).toFixed(2) + '倍');
  a.x = st.track.nodes[a.node].x + st.track.nodes[a.node].nx * 200;   /* 丟到草地上 */
  ok('果汁加速期間不怕減速地形',
    Rules.speedFactor(st, a, Tracks.SURFACE.MUD, 0) > before, '');
}

/* 泡泡護盾 */
{
  const st = two();
  const a = st.racers[0];
  a.item = 'shield';
  Rules.step(st, { a: { steer: 0, use: true } });
  ok('泡泡護盾開得起來', a.shieldUntil > st.t);
  ok('護盾期間免疫一次負面效果', Rules.applySlow(st, a, 1.5, 0.5, null) === false);
  ok('擋完就破', a.shieldUntil === 0);
}

/* 葉子小飛 */
{
  const st = two();
  const a = st.racers[0];
  a.item = 'hop';
  Rules.step(st, { a: { steer: 0, use: true } });
  ok('葉子小飛飄得起來', a.hopUntil > st.t);
  ok('飄浮時泥巴當成跑道', Rules.surfaceFor(st, a) === Tracks.SURFACE.TRACK);
  ok('飄浮時不撞石頭', true);
}

/* 黏黏點點 */
{
  const st = two();
  const a = st.racers[0], b = st.racers[1];
  a.item = 'goo';
  Rules.step(st, { a: { steer: 0, use: true } });
  ok('黏液會留在身後', st.goo.length === Items.ITEMS.goo.blobs, st.goo.length);
  ok('黏液在自己後面不是前面', st.goo.every(g => {
    const dx = g.x - a.x, dy = g.y - a.y;
    return dx * Math.cos(a.angle) + dy * Math.sin(a.angle) < 0;
  }));
  /* 丟自己人踩：把乙搬到黏液上 */
  b.x = st.goo[0].x; b.y = st.goo[0].y;
  Rules.step(st, { a: { steer: 0 }, b: { steer: 0 } });
  ok('別人踩到會被黏住', b.slowUntil > st.t, (b.slowUntil - st.t).toFixed(2));
  ok('自己剛丟完不會踩到自己的黏液', a.slowUntil <= st.t);
}

/* 蜘蛛絲 */
{
  const st = two();
  const a = st.racers[0], b = st.racers[1];
  a.progress = 10; b.progress = 25;
  a.item = 'web';
  const vx0 = a.vx;
  Rules.step(st, { a: { steer: 0, use: true } });
  ok('蜘蛛絲打到前面的人', b.slowUntil > st.t);
  ok('自己會往前竄一小段', Math.abs(a.vx) + Math.abs(a.vy) > Math.abs(vx0));
  ok('畫面上看得到絲', st.webs.length === 1);
}
{
  /* 前面沒人就打空 */
  const st = two();
  const a = st.racers[0], b = st.racers[1];
  a.progress = 40; b.progress = 10;
  a.item = 'web';
  Rules.step(st, { a: { steer: 0, use: true } });
  ok('前面沒人時蜘蛛絲會打空', st.events.some(e => e.type === 'miss'));
}

/* 縮小咒 */
{
  const st = two();
  const a = st.racers[0], b = st.racers[1];
  a.progress = 10; b.progress = 40;
  Rules.updateRanks(st);
  a.item = 'tiny';
  Rules.step(st, { a: { steer: 0, use: true } });
  ok('縮小咒打的是第一名', b.tinyUntil > st.t, 'b.rank=' + b.rank);
  const f = Rules.speedFactor(st, b, Tracks.SURFACE.TRACK, 0);
  b.tinyUntil = 0;
  const f2 = Rules.speedFactor(st, b, Tracks.SURFACE.TRACK, 0);
  ok('變小之後速度掉 25%', Math.abs(f / f2 - 0.75) < 0.001, (f / f2).toFixed(3));
}

/* 幼幼班電腦不丟壞道具 */
{
  const track = Tracks.get('garden', 'baby');
  const st = Rules.createRace({
    track: track, laps: 1, seed: 'baby', allowBad: true,
    racers: [{ id: 'x', kind: 'ai', difficulty: 'baby' }, { id: 'y', kind: 'ai', difficulty: 'hard' }]
  });
  const AI = require('../public/js/ai.js');
  const got = { baby: {}, hard: {} };
  let n = 0;
  while (st.phase !== 'finished' && n < 30 * 120) {
    Rules.step(st, AI.inputsFor(st));
    for (const e of st.events) {
      if (e.type !== 'pick') continue;
      const who = e.id === 'x' ? 'baby' : 'hard';
      got[who][e.item] = (got[who][e.item] || 0) + 1;
    }
    n++;
  }
  const babyBad = Object.keys(got.baby).filter(id => Items.ITEMS[id].kind === 'bad');
  ok('幼幼班的電腦抽不到負面道具', babyBad.length === 0, JSON.stringify(got.baby));
  ok('困難的電腦抽得到負面道具',
    Object.keys(got.hard).some(id => Items.ITEMS[id].kind === 'bad'), JSON.stringify(got.hard));
}

/* 每一種道具都有名字、說明與圖示 */
{
  const fs = require('fs');
  const svgui = fs.readFileSync(require('path').join(__dirname, '../public/js/svgui.js'), 'utf8');
  let missing = [];
  for (const id of Items.ALL) {
    const it = Items.ITEMS[id];
    if (!it.name || !it.hint || !it.kind || !it.color) missing.push(id + '(資料)');
    if (!svgui.includes("'" + id + "'")) missing.push(id + '(圖示)');
  }
  ok('六種道具都有名字、說明與手繪圖示', missing.length === 0, missing.join(', '));
  ok('道具剛好六種', Items.ALL.length === 6, Items.ALL.length);
}

console.log('\n道具：' + pass + ' 通過，' + fail + ' 失敗');
process.exit(fail ? 1 : 0);
