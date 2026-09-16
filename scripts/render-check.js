/* ===== scripts/render-check.js — 美術資產完整性 =====
 * 八隻毛毛蟲、六套賽道主題、所有圖示都要齊全而且分得出來，
 * 而且不能出現 emoji 文字美術（每台裝置長得都不一樣）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Chars = require('../public/js/themes/characters.js');
const TrackArt = require('../public/js/themes/tracks-art.js');
const Tracks = require('../public/js/tracks.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  OK   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  → ' + extra : '')); }
}
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

console.log('美術資產\n');

/* ---------- 八隻毛毛蟲 ---------- */
ok('毛毛蟲剛好八隻', Chars.CHARACTERS.length === 8, Chars.CHARACTERS.length);
ok('每隻都有名字、主色、深淺色、花紋與形狀',
  Chars.CHARACTERS.every(c => c.name && c.body && c.bodyDark && c.bodyLight && c.belly && c.mark && c.pattern && c.shape));
ok('主色八隻都不一樣', new Set(Chars.CHARACTERS.map(c => c.body)).size === 8);
ok('花紋八隻都不一樣', new Set(Chars.CHARACTERS.map(c => c.pattern)).size === 8);
ok('色彩輔助的形狀八隻都不一樣', new Set(Chars.CHARACTERS.map(c => c.shape)).size === 8);

/* 顏色要夠遠，才「能清楚辨別避免玩家誤判」 */
function rgb(hex) {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}
let minDist = 1e9, nearest = '';
for (let i = 0; i < Chars.CHARACTERS.length; i++) {
  for (let j = i + 1; j < Chars.CHARACTERS.length; j++) {
    const a = rgb(Chars.CHARACTERS[i].body), b = rgb(Chars.CHARACTERS[j].body);
    const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    if (d < minDist) { minDist = d; nearest = Chars.CHARACTERS[i].name + '／' + Chars.CHARACTERS[j].name; }
  }
}
ok('最接近的兩隻顏色也分得出來（RGB 距離 > 70）', minDist > 70, Math.round(minDist) + '（' + nearest + '）');

/* ---------- 六套賽道主題 ---------- */
const themeIds = Object.keys(TrackArt.THEMES);
ok('賽道主題剛好六套', themeIds.length === 6, themeIds.length);
ok('每張手設賽道都指到存在的主題',
  Tracks.TRACKS.every(t => TrackArt.THEMES[t.theme]),
  Tracks.TRACKS.filter(t => !TrackArt.THEMES[t.theme]).map(t => t.id).join(','));
ok('每套主題都有完整配色',
  themeIds.every(id => {
    const th = TrackArt.THEMES[id];
    return th.grass && th.grassDark && th.grassAlt && th.road && th.roadDark && th.roadEdge
      && th.mud && th.boost && th.sky && th.rock && th.rockDark && th.decor.length;
  }));
ok('有一套是夜間主題', themeIds.some(id => TrackArt.THEMES[id].night));

/* ---------- 不能有 emoji 文字美術 ---------- */
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
const files = ['public/js/render.js', 'public/js/svgui.js', 'public/js/app.js',
  'public/js/online.js', 'public/js/themes/characters.js', 'public/js/themes/tracks-art.js',
  'public/index.html', 'public/css/style.css'];
const dirty = files.filter(f => EMOJI.test(read(f)));
ok('程式與畫面裡沒有 emoji 文字美術', dirty.length === 0, dirty.join(', '));

/* ---------- 立體感：畫賽道時真的有用到光源與陰影 ---------- */
const render = read('public/js/render.js');
ok('賽道有固定光源', /const LIGHT\s*=/.test(render));
ok('跑道有草地斷面（路肩）', /BANK/.test(render));
ok('跑道內側有投影', /rgba\(0,0,0,\.3/.test(render));
ok('跑道內側有邊光', /rgba\(255,255,255,\.2/.test(render));
ok('彎道有緣石', /drawCurbs/.test(render));
ok('石頭有接地陰影與高光', /接地陰影/.test(render) && /高光/.test(render));
ok('毛毛蟲身體用漸層做立體', /createRadialGradient/.test(render));
ok('毛毛蟲有腳', /小腳/.test(render));
ok('描邊走不含封口的路徑（捷徑才不會有假接縫）', /ribbonEdges/.test(render));

/* ---------- 圖示 ---------- */
const svgui = read('public/js/svgui.js');
for (const name of ['gearIcon', 'closeIcon', 'arrowIcon', 'flagIcon', 'starIcon', 'settingIcon', 'itemIcon']) {
  ok('有 ' + name, svgui.includes('function ' + name));
}
ok('左右箭頭互為鏡像且置中', svgui.includes("'M34 10 14 24 34 38z'") && svgui.includes("'M14 10 34 24 14 38z'"));

console.log('\n美術資產：' + pass + ' 通過，' + fail + ' 失敗');
process.exit(fail ? 1 : 0);
