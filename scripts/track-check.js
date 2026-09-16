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

console.log('\n賽道：' + pass + ' 通過，' + fail + ' 失敗');
process.exit(fail ? 1 : 0);
