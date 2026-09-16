/* ===== scripts/audio-check.js — 音訊資產與設定 ===== */
'use strict';
global.self = global;
const Audio2 = require('../public/js/audio.js');
const TrackArt = require('../public/js/themes/tracks-art.js');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  OK   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  → ' + extra : '')); }
}

console.log('音訊\n');

ok('主旋律有四小節', Audio2.MELODY.length === 32, Audio2.MELODY.length);
ok('主旋律不是一片休止', Audio2.MELODY.filter(n => n !== null).length > 20);
ok('六個賽道主題各有一組樂器', Object.keys(Audio2.VOICES).length === 6);
ok('每個賽道主題都有對應的樂器',
  Object.keys(TrackArt.THEMES).every(id => Audio2.VOICES[id]),
  Object.keys(TrackArt.THEMES).filter(id => !Audio2.VOICES[id]).join(','));
ok('各主題的樂器音色不完全一樣',
  new Set(Object.values(Audio2.VOICES).map(v => v.wave + ':' + v.root)).size >= 5);

/* 沒有 AudioContext 的環境（Node）不能爆掉，只能安靜地不出聲 */
const a = Audio2.create();
ok('沒有 Web Audio 時 unlock 不會爆炸', a.unlock() === false);
a.apply({ bgm: false, sfx: true, sfxVol: 0.5 });
a.play('wiggle'); a.play('不存在的音效'); a.startBgm('garden'); a.stopBgm();
ok('沒有 Web Audio 時播放不會爆炸', true);
ok('設定存得進去', a.settings.bgm === false && a.settings.sfxVol === 0.5);

/* 遊戲裡會用到的音效都要存在 */
const NEEDED = ['wiggle', 'pad', 'pick', 'wall', 'bump', 'goo', 'blocked', 'hit', 'lap', 'count', 'go', 'finish', 'tap'];
const missing = NEEDED.filter(n => !a.SFX_NAMES.includes(n));
ok('遊戲會用到的音效都有做', missing.length === 0, missing.join(','));

/* app.js 播的每一個音效都要真的存在 */
const app = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
const used = [];
const re = /audio\.play\('([^']+)'\)/g;
let m;
while ((m = re.exec(app))) if (!used.includes(m[1])) used.push(m[1]);
const bad = used.filter(n => !a.SFX_NAMES.includes(n));
ok('app.js 播的音效全部存在', bad.length === 0, bad.join(','));
console.log('    用到的音效：' + used.join('、'));

/* 首次手勢才解鎖：index.html 不能有自動播放 */
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
ok('沒有 autoplay 的音訊元素', !/autoplay/i.test(html));
ok('第一次點擊才解鎖音訊', /pointerdown.*unlockAudio|unlockAudio.*once/s.test(app));

/* 設定彈窗要有獨立的音樂與音效開關 */
for (const id of ['set-bgm', 'set-bgm-vol', 'set-sfx', 'set-sfx-vol']) {
  ok('設定裡有 ' + id, html.includes('id="' + id + '"'));
}

console.log('\n音訊：' + pass + ' 通過，' + fail + ' 失敗');
process.exit(fail ? 1 : 0);
