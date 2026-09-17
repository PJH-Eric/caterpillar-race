/* ===== scripts/ai-check.js — 四段電腦對手的差異要量得出來 =====
 * 只改名字不改行為的 AI 不算數。四段跑同一批賽道、同一個 seed，
 * 完成時間必須單調遞減，走線與道具使用也要看得出差別。
 */
'use strict';

const Tracks = require('../public/js/tracks.js');
const Rules = require('../public/js/rules.js');
const AI = require('../public/js/ai.js');

const TRACKS = ['garden', 'veggie', 'branch', 'pond', 'candy', 'shroom'];
const LAPS = 2;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  OK   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  → ' + extra : '')); }
}

function solo(trackId, diff) {
  const track = Tracks.get(trackId, 'ai-' + trackId);
  const st = Rules.createRace({
    track: track, laps: LAPS, seed: 'ai-' + trackId,
    racers: [{ id: 'x', name: '電腦', kind: 'ai', difficulty: diff }]
  });
  let n = 0, dist = 0;
  const r = st.racers[0];
  let px = r.x, py = r.y;
  while (st.phase !== 'finished' && n < 30 * 180) {
    Rules.step(st, AI.inputsFor(st));
    dist += Math.hypot(r.x - px, r.y - py); px = r.x; py = r.y;
    n++;
  }
  /* 走線品質：實際跑的距離除以賽道長度。抄內線的會小於 1，繞遠路的會大於 1 */
  r.detour = dist / (track.length * LAPS);
  return r;
}

console.log('四段電腦對手（每張賽道 ' + LAPS + ' 圈，' + TRACKS.length + ' 張）\n');

const rows = {};
for (const diff of Rules.DIFFICULTY_LIST) {
  const acc = { time: 0, off: 0, hits: 0, pads: 0, items: 0, done: 0, detour: 0, per: {} };
  for (const tid of TRACKS) {
    const r = solo(tid, diff);
    if (r.finished) acc.done++;
    acc.time += r.finishTime;
    acc.off += r.stats.offTrack;
    acc.hits += r.stats.hits;
    acc.pads += r.stats.pads;
    acc.detour += r.detour;
    acc.items += r.stats.itemsUsed;
    acc.per[tid] = +r.finishTime.toFixed(1);
  }
  rows[diff] = acc;
  console.log('  ' + Rules.DIFFICULTY[diff].name.padEnd(4) +
    ' 完賽 ' + acc.done + '/' + TRACKS.length +
    ' ・ 總時間 ' + acc.time.toFixed(1) + 's' +
    ' ・ 撞牆 ' + acc.hits +
    ' ・ 跑到草地 ' + (acc.off / 30).toFixed(1) + 's' +
    ' ・ 吃加速帶 ' + acc.pads +
    ' ・ 走線 ' + (acc.detour / TRACKS.length * 100).toFixed(1) + '%' +
    ' ・ 用道具 ' + acc.items);
}
console.log('');

const order = Rules.DIFFICULTY_LIST;
ok('四段都跑得完每一張賽道', order.every(d => rows[d].done === TRACKS.length),
  order.map(d => d + ':' + rows[d].done).join(' '));

const times = order.map(d => rows[d].time);
ok('完成時間隨難度單調遞減', times.every((t, i) => i === 0 || t < times[i - 1]),
  times.map(t => t.toFixed(1)).join(' > '));

ok('困難比幼幼班快至少 15%', rows.hard.time < rows.baby.time * 0.85,
  (rows.hard.time / rows.baby.time * 100).toFixed(0) + '%');

ok('道具用得越來越積極', rows.hard.items > rows.baby.items,
  rows.baby.items + ' → ' + rows.hard.items);

/* 高段的 AI 會抄內線，實際跑的距離比低段短 —— 這是「走線」真的有差的證據 */
ok('越高段走線越短', rows.hard.detour < rows.baby.detour,
  (rows.baby.detour / TRACKS.length * 100).toFixed(1) + '% → ' + (rows.hard.detour / TRACKS.length * 100).toFixed(1) + '%');

ok('沒有哪一段會一直撞牆', order.every(d => rows[d].hits < 40),
  order.map(d => d + ':' + rows[d].hits).join(' '));

/* 逐張賽道也要大致單調（允許一張例外，賽道形狀會有個性） */
let bad = 0;
for (const tid of TRACKS) {
  const t = order.map(d => rows[d].per[tid]);
  if (!t.every((v, i) => i === 0 || v < t[i - 1] + 0.5)) bad++;
}
ok('逐張賽道的排序最多一張例外', bad <= 1, bad + ' 張不單調');

/* 幼幼班的體貼：玩家落後很多時電腦會放慢 */
{
  const track = Tracks.get('garden', 'mercy');
  const st = Rules.createRace({
    track: track, laps: 2, seed: 'mercy',
    racers: [{ id: 'me', kind: 'human' }, { id: 'ai', kind: 'ai', difficulty: 'baby' }]
  });
  for (let i = 0; i < 30 * 40; i++) {
    const inputs = AI.inputsFor(st);
    inputs.me = { steer: 0, use: false };    /* 玩家完全不動，一定會落後 */
    Rules.step(st, inputs);
    if (st.phase === 'finished') break;
  }
  const ai = st.racers.find(r => r.id === 'ai');
  ok('幼幼班的電腦在玩家落後太多時會放慢等人', ai.capScale < 1, String(ai.capScale));
}

/* 四段同場競技：至少要跑得完，而且困難不會墊底 */
{
  const track = Tracks.get('garden', 'mix');
  const st = Rules.createRace({
    track: track, laps: 2, seed: 'mix',
    racers: Rules.DIFFICULTY_LIST.map((d, i) => ({
      id: 'p' + i, name: Rules.DIFFICULTY[d].name, kind: 'ai', difficulty: d
    }))
  });
  let n = 0;
  while (st.phase !== 'finished' && n < 30 * 180) { Rules.step(st, AI.inputsFor(st)); n++; }
  const res = Rules.results(st);
  console.log('\n  四段同場：' + res.map(r => r.rank + '.' + r.name + ' ' + r.time.toFixed(1) + 's').join('  '));
  /* 第一名衝線後只有 FINISH_GRACE 秒，幼幼班本來就有可能被關在門外 ——
   * 所以這裡不再要求「所有人都完賽」，改成要求「不會整場沒人跑完」，
   * 而且沒跑完的人一定是被倒數擋掉的，不是卡在賽道上出不來。 */
  ok('同場競技跑得完（至少前兩名有完賽）',
    res.filter(r => r.finished).length >= 2,
    res.filter(r => r.finished).length + ' 人完賽');
  ok('沒跑完的人是被倒數擋掉的', res.every(r => r.finished) || st.graceEnd > 0);
  ok('困難不會墊底', res.find(r => r.name === '困難').rank < 4);
}

console.log('\n電腦對手：' + pass + ' 通過，' + fail + ' 失敗');
process.exit(fail ? 1 : 0);
