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

/* 時間界線跟著 BASE_SPEED 走。這幾條在抓的是「賽道設計得太長／太短」，
 * 不是在抓速度 —— 基礎速度一調慢，同一張賽道本來就會跑比較久，
 * 界線寫死的話就會變成每次調手感都要回來改一次數字。
 * 175 是這些界線當初校準時的基礎速度。 */
const TIME_SCALE = 175 / Rules.C.BASE_SPEED;
const LAP_MIN = 8 * TIME_SCALE, LAP_MAX = 70 * TIME_SCALE;
const SPRINT_MIN = 20 * TIME_SCALE, SPRINT_MAX = 70 * TIME_SCALE;

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
  ok(def.id + ' 一圈在合理時間內（' + LAP_MIN.toFixed(0) + '～' + LAP_MAX.toFixed(0) + ' 秒）',
    r.finishTime > LAP_MIN && r.finishTime < LAP_MAX, r.finishTime.toFixed(1));
  ok(def.id + ' 道具葉數量足夠', tr.items.length >= 10, tr.items.length);
  ok(def.id + ' 有加速帶', tr.boosts.length >= 1);
  ok(def.id + ' 圈數設定在 1～5 之間', tr.laps >= 1 && tr.laps <= 5);
  ok(def.id + ' 道具葉全部在跑道上',
    tr.items.every(it => Tracks.surfaceAt(tr, it.x, it.y) !== Tracks.SURFACE.GRASS));
  ok(def.id + ' 加速帶全部在跑道上',
    tr.boosts.every(b => Tracks.surfaceAt(tr, b.x, b.y) !== Tracks.SURFACE.GRASS));
}

console.log('\n  隨機賽道（120 個 seed）');
let worst = 0, bestT = 999, badSeeds = [], badStarts = [];
for (let i = 0; i < 120; i++) {
  const seed = 'rnd-' + i;
  const tr = Tracks.get('random', seed);
  let onCenter = 0;
  for (const nd of tr.nodes) if (Tracks.surfaceAt(tr, nd.x, nd.y) !== Tracks.SURFACE.GRASS) onCenter++;
  if (onCenter !== tr.nodes.length) badSeeds.push(seed + '(斷線)');
  if (tr.length < 2000 || tr.length > 7600) badSeeds.push(seed + '(長度 ' + Math.round(tr.length) + ')');
  const startNodes = new Set(tr.starts.map(s => s.node));
  const start = tr.nodes[tr.startNode];
  const startAngle = Math.atan2(start.ty, start.tx);
  let maxStartTurn = 0;
  for (let d = 0; d <= Tracks.START_STRAIGHT_NODES; d++) {
    const nd = tr.nodes[Tracks.idx(tr, tr.startNode + d)];
    let da = Math.atan2(nd.ty, nd.tx) - startAngle;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    maxStartTurn = Math.max(maxStartTurn, Math.abs(da));
  }
  if (startNodes.size !== 1 || maxStartTurn >= 0.7) {
    badStarts.push(seed + '(節點 ' + Array.from(startNodes).join(',') + '，彎 ' + maxStartTurn.toFixed(2) + ')');
  }
  /* 抽樣實際開開看，每 10 個 seed 跑一次 */
  if (i % 10 === 0) {
    const r = driveOneLap(tr, seed);
    if (!r.finished) badSeeds.push(seed + '(跑不完)');
    else { worst = Math.max(worst, r.finishTime); bestT = Math.min(bestT, r.finishTime); }
  }
}
console.log('    抽樣一圈時間 ' + bestT.toFixed(1) + 's ～ ' + worst.toFixed(1) + 's');
ok('120 個隨機 seed 都長得出可以跑的賽道', badSeeds.length === 0, badSeeds.slice(0, 6).join(', '));
ok('隨機賽道一圈不會誇張地長', worst < 75, worst.toFixed(1));
ok('隨機賽道起跑同排且前段直線', badStarts.length === 0, badStarts.slice(0, 4).join(', '));

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

/* 彎道夠不夠多：只有圓環的話，每一局跑起來都一樣 */
function cornerCount(tr) {
  const nd = tr.nodes, n = nd.length;
  let c = 0, inTurn = false;
  for (let i = 0; i < n; i++) {
    const a = nd[i], b = nd[(i + 12) % n];
    let d = Math.atan2(b.ty, b.tx) - Math.atan2(a.ty, a.tx);
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    const turning = Math.abs(d) > 0.42;
    if (turning && !inTurn) c++;
    inTurn = turning;
  }
  return c;
}
{
  let sum = 0, curvy = 0, n = 0;
  for (let i = 0; i < 80; i++) {
    const def = Tracks.randomDef('corner-' + i);
    sum += cornerCount(Tracks.build(def));
    if (def.shape === 'circuit' || def.shape === 'hairpin') curvy++;
    n++;
  }
  const avg = sum / n;
  console.log('    隨機賽道平均彎道數 ' + avg.toFixed(1) + '，多彎版型佔 ' + Math.round(curvy / n * 100) + '%');
  ok('隨機賽道彎道夠多（平均 ≥ 8 個）', avg >= 8, avg.toFixed(1));
  ok('多彎版型是多數（≥ 55%）', curvy / n >= 0.55, Math.round(curvy / n * 100) + '%');
}

/* 衝刺賽道：起點到終點，沒有圈數 */
{
  const sprints = Tracks.TRACKS.filter(t => t.open);
  ok('至少有兩張衝刺賽道', sprints.length >= 2, sprints.length);
  for (const def of sprints) {
    const tr = Tracks.build(def);
    ok(def.id + ' 是開放路徑（頭尾不相接）',
      Math.hypot(tr.nodes[0].x - tr.nodes[tr.nodes.length - 1].x,
        tr.nodes[0].y - tr.nodes[tr.nodes.length - 1].y) > 600);
    ok(def.id + ' 圈數設定成 1', def.laps === 1);
    const r = driveOneLap(tr, 'sp-' + def.id);
    ok(def.id + ' 從起點跑得到終點', r.finished, r.node + '/' + tr.nodes.length);
    ok(def.id + ' 全程時間合理（' + SPRINT_MIN.toFixed(0) + '～' + SPRINT_MAX.toFixed(0) + ' 秒）',
      r.finishTime > SPRINT_MIN && r.finishTime < SPRINT_MAX, r.finishTime.toFixed(1));
    ok(def.id + ' 起跑格排在路徑開頭', tr.starts.every(s => s.node < tr.nodes.length * 0.1));
  }
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

/* ---------- 彎道不能比毛毛蟲轉得過去的還急 ----------
 * 踩到加速帶大概是基礎速度的 1.3 倍；那個速度的迴轉半徑算出來當門檻。
 * 賽道有一成以上的地方比這還彎的話，全速進彎就會撞出去。
 */
{
  const C = Rules.C;
  const FAST_SPEED = C.BASE_SPEED * 1.3;
  const turn = C.TURN * (1 - C.TURN_SPEED_FALLOFF * Math.min(1, FAST_SPEED / C.BASE_SPEED));
  const minR = FAST_SPEED / turn;

  /** 每個節點的局部轉彎半徑，由小到大 */
  function radii(tr) {
    const nd = tr.nodes, n = nd.length, out = [];
    const at = i => nd[Tracks.idx(tr, i)];
    for (let i = 0; i < n; i++) {
      const a = at(i - 2), b = at(i), c = at(i + 2);
      const ax = b.x - a.x, ay = b.y - a.y, bx = c.x - b.x, by = c.y - b.y;
      const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
      const ang = Math.abs(Math.atan2(ax * by - ay * bx, ax * bx + ay * by));
      out.push(ang < 1e-6 ? Infinity : (la + lb) * 0.5 / ang);
    }
    return out.sort((x, y) => x - y);
  }

  const bad = [];
  const check = (name, tr) => {
    const rs = radii(tr);
    const tight = rs.filter(r => r < minR).length / rs.length;
    if (tight > 0.10) bad.push(name + ' ' + (tight * 100).toFixed(0) + '%');
  };
  for (const def of Tracks.TRACKS) check(def.id, Tracks.build(def));
  for (let i = 0; i < 40; i++) check('rnd' + i, Tracks.get('random', 'turn-' + i));
  ok('高速下轉得過去的彎（比 ' + minR.toFixed(0) + ' 還急的路段 ≤ 10%）',
    bad.length === 0, bad.slice(0, 6).join(', '));

  /* 真人不是每一幀都在修方向。模擬「反應慢 0.25 秒、而且油門全程按到底」的玩家，
   * 這樣還會被甩到草地上的話，賽道就是太難控制了。 */
  const wild = [];
  for (const def of Tracks.TRACKS) {
    const tr = Tracks.build(def);
    const st = Rules.createRace({ track: tr, laps: 1, seed: 'grip-' + def.id,
      racers: [{ id: 'a', kind: 'human', difficulty: 'normal' }] });
    let n = 0, grass = 0, held = { steer: 0, gas: 1, man: 0, use: false };
    while (st.phase !== 'finished' && n < 30 * 300) {
      const r = st.racers[0];
      r.padUntil = st.t + 5;                      /* 加速帶效果一直開著，等於全程最快 */
      if (n % 8 === 0) {                          /* 每 0.25 秒才改一次方向 */
        r.kind = 'ai'; r.difficulty = 'hard';
        const i = AI.input(st, r);
        r.kind = 'human'; r.difficulty = 'normal';
        held = { steer: i.steer, gas: 1, man: 0, use: false };
      }
      Rules.step(st, { a: held });
      if (Tracks.surfaceAt(tr, r.x, r.y) === Tracks.SURFACE.GRASS) grass++;
      n++;
    }
    const pct = grass / Math.max(1, n) * 100;
    if (pct > 4) wild.push(def.id + ' ' + pct.toFixed(0) + '%');
  }
  ok('反應慢半拍的玩家全程高速也不會一直被甩到草地（≤ 4%）',
    wild.length === 0, wild.slice(0, 6).join(', '));
}

console.log('\n賽道：' + pass + ' 通過，' + fail + ' 失敗');
process.exit(fail ? 1 : 0);
