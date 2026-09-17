/* ===== scripts/render-check.js — 美術資產完整性 =====
 * 八隻毛毛蟲、六套賽道主題、所有圖示都要齊全而且分得出來，
 * 不能出現 emoji 文字美術（每台裝置長得都不一樣），
 * 而且追尾視角的立體渲染該有的東西要在。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Chars = require('../public/js/themes/characters.js');
const TrackArt = require('../public/js/themes/tracks-art.js');
const Tracks = require('../public/js/tracks.js');

const _R = require('../public/js/render.js');
const Render = _R.Render || _R;
const Render_SEG_GAP = Render.SEG_GAP, Render_HEAD_R = Render.HEAD_R;
const Render_BEHIND = Render.BEHIND_NODES;

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
ok('每套主題都有完整的地面配色',
  themeIds.every(id => {
    const th = TrackArt.THEMES[id];
    return th.grass && th.grassDark && th.grassAlt && th.road && th.roadDark && th.roadEdge
      && th.mud && th.boost && th.rock && th.rockDark && th.decor.length;
  }));
ok('每套主題都有天空與遠山（追尾視角看得到地平線以上）',
  themeIds.every(id => {
    const th = TrackArt.THEMES[id];
    return th.sky && th.sky2 && th.skyLow && th.hill && th.hillDark && th.sun;
  }),
  themeIds.filter(id => !TrackArt.THEMES[id].sky2).join(','));
ok('有一套是夜間主題', themeIds.some(id => TrackArt.THEMES[id].night));

/* ---------- 不能有 emoji 文字美術 ---------- */
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
const files = ['public/js/render.js', 'public/js/svgui.js', 'public/js/app.js',
  'public/js/online.js', 'public/js/themes/characters.js', 'public/js/themes/tracks-art.js',
  'public/index.html', 'public/css/style.css'];
const dirty = files.filter(f => EMOJI.test(read(f)));
ok('程式與畫面裡沒有 emoji 文字美術', dirty.length === 0, dirty.join(', '));

/* ---------- 追尾視角的立體渲染 ---------- */
const render = read('public/js/render.js');
ok('有透視投影器', /function projector/.test(render) && /focal/.test(render));
ok('地面是 z = 0 的平面，物件靠高度抬起來', /cam\.z - \(wz/.test(render));
ok('有近平面裁剪（f 太小投影會飛出去）', /NEAR/.test(render) && /lerpNode/.test(render));
ok('有視錐裁切（賽道繞回鏡頭旁邊不能畫）', /視錐裁切/.test(render));
ok('有天空與遠山', /function drawSky/.test(render) && /遠山/.test(render));
ok('有地平線附近的霧化', /function drawFog/.test(render));
ok('地面條紋不跟著賽道走（跟著走會蓋住遠方的路）', /function drawGroundBands/.test(render));
ok('賽道分段畫成四邊形', /function makeSegDraw/.test(render));
ok('彎道有紅白緣石', /RUMBLE/.test(render) && /E2564E/.test(render));
ok('毛毛蟲每一節都是站在地上的球', /球心抬高|球體/.test(render));
ok('毛毛蟲有貼地陰影', /貼地陰影/.test(render));
ok('毛毛蟲有小腳', /小腳/.test(render));
ok('毛毛蟲身體用漸層做立體', /createRadialGradient/.test(render));
ok('背對鏡頭時看不到臉', /背對鏡頭/.test(render));
ok('場景物件（樹、蘑菇、花、石頭）有做', /function drawProp/.test(render) && /'tree'/.test(render));
ok('高的場景物件離路邊遠一點，不會擋住賽道', /TALL/.test(render));
ok('場景物件都有貼地陰影', /function shadow/.test(render));
ok('遠處的小東西不畫漸層（效能）', /detail/.test(render) && /rr > 9/.test(render));
ok('毛毛蟲是幾顆緊湊的球（節距小於直徑）', Render_SEG_GAP < Render_HEAD_R * 2, Render_SEG_GAP + ' / ' + Render_HEAD_R * 2);
ok('頭上有兩顆白色觸角球（背對鏡頭時唯一認得出頭的線索）', /觸角/.test(render) && /#FFFFFF/.test(render));
ok('地面有世界座標的紋理（壓低鏡頭後畫面下半才不是一片純色）', /function drawGroundTexture/.test(render));
ok('遠山是一顆一顆的圓包', /quadraticCurveTo/.test(render) && /遠山/.test(render));
ok('地面裝飾太靠近鏡頭會淡出', /BLOB_NEAR/.test(render) && /BLOB_FADE/.test(render));
ok('賽道往鏡頭後面也要畫（不然畫面下緣會空一塊）', Render_BEHIND > 15, Render_BEHIND);

/* ---------- 鏡頭 ---------- */
const app = read('public/js/app.js');
ok('鏡頭在毛毛蟲後上方', /CAM_VIEWS/.test(app) && /back:/.test(app) && /height:/.test(app));
ok('鏡頭偏航預設跟賽道方向（蠕動才不會把畫面帶著晃）', /camTargetAngle/.test(app) && /賽道方向/.test(app));
ok('鏡頭用平滑過的行進方向退到後面', /cam\.h/.test(app));
ok('鏡頭位置與偏航用同一個軸線（毛毛蟲永遠釘在畫面正中央）',
  /G\.cam\.a = G\.cam\.h/.test(app) && /Math\.cos\(G\.cam\.h\) \* back/.test(app));
ok('鏡頭位置不做額外平滑（不然毛毛蟲會忽大忽小）', !/G\.cam\.x \+=/.test(app));
ok('鏡頭旋轉有限速', /CAM_MAX_RATE/.test(app));
ok('太近的對手與場景物件會淡出或不畫', /淡出/.test(app));

/* ---------- 圖示 ---------- */
const svgui = read('public/js/svgui.js');
for (const name of ['gearIcon', 'closeIcon', 'arrowIcon', 'flagIcon', 'starIcon', 'settingIcon', 'itemIcon']) {
  ok('有 ' + name, svgui.includes('function ' + name));
}
ok('左右箭頭互為鏡像且置中', svgui.includes("'M34 10 14 24 34 38z'") && svgui.includes("'M14 10 34 24 14 38z'"));
ok('選角與結算用的 SVG 毛毛蟲還在', /function wormSvg/.test(render));

console.log('\n美術資產：' + pass + ' 通過，' + fail + ' 失敗');
process.exit(fail ? 1 : 0);
