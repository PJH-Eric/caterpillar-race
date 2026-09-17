/* ===== scripts/track-check.js — 賽道壓力測試 =====
 * 六張手設賽道要走得通，隨機賽道連跑 120 個 seed 也不能長出跑不完的東西。
 */
'use strict';

const Tracks = require('../public/js/tracks.js');
const Rules = require('../public/js/rules.js');
const AI = require('../public/js/ai.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) pass++;
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  → ' + extra : '')); }
}

function driveOneLap(track, seed) {
  const st = Rules.createRace({
    track: track, laps: 1, seed: seed,
    racers: [{ id: 'x', kind: 'ai', difficulty: 'normal' }]
  });
  let n = 0;
  while (st.phase !== 'finished' && n < 30 * 180) { Rules.step(st, AI.inputsFor(st)); n++; }
  return st.racers[0];
}

console.log('賽道壓力測試\n');

console.log('  手設賽道');
for (const def of Tracks.TRACKS) {
  const tr = Tracks.build(def);
  const r = driveOneLap(tr, 'tc-' + def.id);
  console.log('    ' + def.name.padEnd(6) +
    ' 長度 ' + Math.round(tr.length) +
    ' ・ 節點 ' + tr.nodes.length +
    ' ・ 道具葉 ' + tr.items.length +
    ' ・ 一圈 ' + r.finishTime.toFixed(1) + 's');
  ok(def.id + ' 跑得完一圈', r.finished, r.lap + ' 圈');
  ok(def.id + ' 一圈在合理時間內（8～60 秒）', r.finishTime > 8 && r.finishTime < 60, r.finishTime.toFixed(1));
  ok(def.id + ' 道具葉數量足夠', tr.items.length >= 10, tr.items.length);
  ok(def.id + ' 有加速帶', tr.boosts.length >= 1);
  ok(def.id + ' 圈數設定在 1～5 之間', tr.laps >= 1 && tr.laps <= 5);
  ok(def.id + ' 道具葉全部在跑道上',
    tr.items.every(it => Tracks.surfaceAt(tr, it.x, it.y) !== Tracks.SURFACE.GRASS));
  ok(def.id + ' 加速帶全部在跑道上',
    tr.boosts.every(b => Tracks.surfaceAt(tr, b.x, b.y) !== Tracks.SURFACE.GRASS));
}

console.log('\n  隨機賽道（120 個 seed）');
let worst = 0, bestT = 999, badSeeds = [];
for (let i = 0; i < 120; i++) {
  const seed = 'rnd-' + i;
  const tr = Tracks.get('random', seed);
  let onCenter = 0;
  for (const nd of tr.nodes) if (Tracks.surfaceAt(tr, nd.x, nd.y) !== Tracks.SURFACE.GRASS) onCenter++;
  if (onCenter !== tr.nodes.length) badSeeds.push(seed + '(斷線)');
  if (tr.length < 1600 || tr.length > 6000) badSeeds.push(seed + '(長度 ' + Math.round(tr.length) + ')');
  /* 抽樣實際開開看，每 10 個 seed 跑一次 */
  if (i % 10 === 0) {
    const r = driveOneLap(tr, seed);
    if (!r.finished) badSeeds.push(seed + '(跑不完)');
    else { worst = Math.max(worst, r.finishTime); bestT = Math.min(bestT, r.finishTime); }
  }
}
console.log('    抽樣一圈時間 ' + bestT.toFixed(1) + 's ～ ' + worst.toFixed(1) + 's');
ok('120 個隨機 seed 都長得出可以跑的賽道', badSeeds.length === 0, badSeeds.slice(0, 6).join(', '));
ok('隨機賽道一圈不會誇張地長', worst < 70, worst.toFixed(1));

/* 版型：不能每一張都是圓環 */
{
  const seen = {};
  for (let i = 0; i < 200; i++) {
    const d = Tracks.randomDef('shape-' + i);
    seen[d.shape] = (seen[d.shape] || 0) + 1;
  }
  console.log('    版型分布 ' + Tracks.SHAPES.map(k => k + ':' + (seen[k] || 0)).join('  '));
  ok('五種版型都抽得到', Tracks.SHAPES.every(k => seen[k] > 0),
    Tracks.SHAPES.filter(k => !seen[k]).join(','));
  ok('沒有哪一種版型獨佔一半以上',
    Tracks.SHAPES.every(k => (seen[k] || 0) < 100),
    JSON.stringify(seen));
}

/* 路面要夠寬，而且不能寬到自己貼到自己 */
function selfOverlap(tr) {
  const nd = tr.nodes, n = nd.length, skip = Math.max(8, Math.round(n * 0.09));
  for (let i = 0; i < n; i++) {
    for (let j = i + skip; j < n; j++) {
      if (n - (j - i) < skip) continue;
      const a = nd[i], b = nd[j];
      const need = (a.w + b.w) * 0.95;
      const dx = a.x - b.x, dy = a.y - b.y;
      if (dx * dx + dy * dy < need * need) return true;
    }
  }
  return false;
}
{
  let narrow = [], glued = [];
  for (const def of Tracks.TRACKS) {
    const tr = Tracks.build(def);
    const w = tr.nodes.reduce((a, n2) => a + n2.w, 0) / tr.nodes.length;
    if (w < 100) narrow.push(def.id + '(' + w.toFixed(0) + ')');
    if (selfOverlap(tr)) glued.push(def.id);
  }
  for (let i = 0; i < 40; i++) {
    const tr = Tracks.get('random', 'wide-' + i);
    const w = tr.nodes.reduce((a, n2) => a + n2.w, 0) / tr.nodes.length;
    if (w < 100) narrow.push('rnd' + i + '(' + w.toFixed(0) + ')');
    if (selfOverlap(tr)) glued.push('rnd' + i);
  }
  ok('每張賽道的路面都夠寬（平均 ≥ 100）', narrow.length === 0, narrow.slice(0, 5).join(', '));
  ok('沒有賽道寬到自己黏住自己', glued.length === 0, glued.slice(0, 5).join(', '));
}

console.log('\n賽道：' + pass + ' 通過，' + fail + ' 失敗');
process.exit(fail ? 1 : 0);
