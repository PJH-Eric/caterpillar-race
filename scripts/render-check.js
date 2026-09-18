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
ok('賽道主題至少九套', themeIds.length >= 9, themeIds.length);
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
ok('有近平面裁剪（f 太小投影會飛出去）', /NEAR/.test(render) && /function clipNear/.test(render));
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
ok('遠處的小東西不畫漸層（效能）', /detail/.test(render) && /rr > 13/.test(render));
ok('毛毛蟲是幾顆緊湊的球（節距小於直徑）', Render_SEG_GAP < Render_HEAD_R * 2, Render_SEG_GAP + ' / ' + Render_HEAD_R * 2);
ok('頭上有兩顆白色觸角球（背對鏡頭時唯一認得出頭的線索）', /觸角/.test(render) && /#FFFFFF/.test(render));
ok('地面有世界座標的紋理（壓低鏡頭後畫面下半才不是一片純色）', /function drawGroundTexture/.test(render));
ok('遠山是一顆一顆的圓包', /quadraticCurveTo/.test(render) && /遠山/.test(render));
ok('地面裝飾太靠近鏡頭會淡出', /BLOB_NEAR/.test(render) && /BLOB_FADE/.test(render));
ok('賽道往鏡頭後面也要畫（不然畫面下緣會空一塊）', Render_BEHIND > 15, Render_BEHIND);
ok('天空與地面的漸層有快取（不要每一幀重建）', /gradCache/.test(render));
ok('渲染端有低效能模式的開關', /lite/.test(render));

/* ---------- 鏡頭 ---------- */
const app = read('public/js/app.js');
ok('鏡頭在毛毛蟲後上方', /CAM_VIEWS/.test(app) && /back:/.test(app) && /height:/.test(app));
ok('鏡頭偏航預設跟賽道方向（修方向時才不會把畫面帶著晃）', /camTargetAngle/.test(app) && /賽道方向/.test(app));
ok('鏡頭用平滑過的行進方向退到後面', /cam\.h/.test(app));
ok('鏡頭位置與偏航用同一個軸線（毛毛蟲永遠釘在畫面正中央）',
  /G\.cam\.a = G\.cam\.h/.test(app) && /Math\.cos\(G\.cam\.h\) \* back/.test(app));
ok('鏡頭位置不做額外平滑（不然毛毛蟲會忽大忽小）', !/G\.cam\.x \+=/.test(app));
ok('鏡頭旋轉有限速', /stepCamYaw/.test(app) && Render.CAM_YAW.maxRate > 0);

/* ---------- head 模式：鏡頭鎖死在車頭上 ---------- */
{
  const html = read('public/index.html');
  const store = read('public/js/storage.js');
  ok('有「鎖定車頭」的鏡頭模式可以選', /value="head"/.test(html));
  ok('預設就是鎖定車頭', /camMode: 'head'/.test(store));
  ok('舊存檔會被帶到鎖定車頭（改 DEFAULTS 對已經有存檔的人沒用）',
    /VERSION/.test(store) && /function migrate/.test(store));
  {
    const S = require('../public/js/storage.js').Store;
    const withStore = raw => {
      global.localStorage = { _v: raw === null ? null : JSON.stringify(raw),
        getItem() { return this._v; }, setItem(k, x) { this._v = x; } };
      return S.load();
    };
    ok('舊存檔的 chase 會帶成 head', withStore({ camMode: 'chase' }).camMode === 'head');
    ok('自己挑過 track 的不動', withStore({ camMode: 'track' }).camMode === 'track');
    ok('轉換過之後又自己挑 chase 就不再被蓋掉',
      withStore({ camMode: 'chase', v: 2 }).camMode === 'chase');
    ok('全新玩家就是 head', withStore(null).camMode === 'head');
    delete global.localStorage;
  }
  ok('head 模式直接回傳車頭角，不混賽道前瞻也不平滑行進方向',
    app.includes("camMode === 'head') return me.angle"));
  ok('head 模式不過鏡頭阻尼器（不然轉彎時鏡頭會落在車頭後面）',
    app.includes("G.cam.h = root.Render.headCamYaw(") && !app.includes('CAM_YAW_LERP.head'));

  /* 30Hz 物理 + 60Hz 繪製：鏡頭不能一格一格地頓，也不能落在車頭後面 */
  const un = a => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };
  const TICK = 1 / 30, FRAME = 1 / 60;
  function sweep(rate, frames) {
    let angle = 0, turnVel = 0, acc = 0, h = 0;
    let judder = 0, maxLag = 0, prevStep = 0;
    for (let f = 0; f < frames; f++) {
      acc += FRAME;
      while (acc >= TICK) { turnVel = rate; angle = un(angle + turnVel * TICK); acc -= TICK; }
      const before = h;
      h = Render.headCamYaw(h, angle, turnVel, FRAME);
      const step = Math.abs(un(h - before));
      if (f > 30) {
        judder = Math.max(judder, Math.abs(step - prevStep));
        maxLag = Math.max(maxLag, Math.abs(un(angle + turnVel * acc - h)));   /* 對次刻度後的真實車頭角 */
      }
      prevStep = step;
    }
    return { judder, maxLag };
  }
  const fast = sweep(2.4, 600);     /* 打死方向 */
  ok('head 模式打死方向時畫面不會一格一格地頓',
    fast.judder < 0.02, '每幀轉動差 ' + (fast.judder * 180 / Math.PI).toFixed(2) + ' 度');
  ok('head 模式鏡頭不會落在車頭後面',
    fast.maxLag < 0.03, '最多落後 ' + (fast.maxLag * 180 / Math.PI).toFixed(2) + ' 度');
  const slow = sweep(0, 300);
  ok('head 模式不轉方向時鏡頭完全不動', slow.judder < 1e-9 && slow.maxLag < 1e-9);

  /* 前饋量要跟濾波的時間常數配起來，不然不是落後就是超前 */
  ok('head 模式的前饋量與濾波時間常數相當',
    Math.abs(Render.HEAD_CAM.lead - Render.HEAD_CAM.tau) < Render.HEAD_CAM.tau * 0.5,
    'lead=' + Render.HEAD_CAM.lead + ' tau=' + Render.HEAD_CAM.tau);
}

/* ---------- 鏡頭阻尼器：過彎時的行為 ---------- */
{
  const Y = Render.CAM_YAW;
  const DT = 1 / 60;
  const un = a => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };

  /* 1. 一路右彎：轉速不能超過上限（落後不多的時候） */
  let cam = { h: 0, rate: 0 }, target = 0, over = 0, maxLag = 0;
  for (let i = 0; i < 600; i++) {
    target += 0.6 * DT;                      /* 賽道以 0.6 弧度／秒轉 */
    const before = cam.h;
    Render.stepCamYaw(cam, target, DT, 0.30);
    const rate = Math.abs(un(cam.h - before)) / DT;
    maxLag = Math.max(maxLag, Math.abs(un(target - cam.h)));
    if (i > 60 && rate > Y.maxRate * 1.02 && Math.abs(un(target - cam.h)) < Y.lagMax) over++;
  }
  ok('定速過彎時轉速不超過上限', over === 0, over + ' 幀超速');
  ok('定速過彎時不會愈落愈遠', maxLag < 1.2, '最多落後 ' + (maxLag * 180 / Math.PI).toFixed(0) + ' 度');

  /* 2. S 彎：目標來回擺，鏡頭永遠不可以往離目標更遠的方向轉 */
  cam = { h: 0, rate: 0 };
  let wrongWay = 0, overshoot = 0;
  for (let i = 0; i < 1200; i++) {
    const t = i * DT;
    target = Math.sin(t * 1.6) * 0.9;        /* 連續 S 彎 */
    const dh = un(target - cam.h);
    const before = cam.h;
    Render.stepCamYaw(cam, target, DT, 0.30);
    const move = un(cam.h - before);
    if (Math.abs(dh) > 0.02 && Math.abs(move) > 1e-9 && move * dh < 0) wrongWay++;
    if (Math.abs(move) > Math.abs(dh) + 1e-9) overshoot++;
  }
  ok('S 彎時鏡頭不會往反方向轉', wrongWay === 0, wrongWay + ' 幀轉錯邊');
  ok('鏡頭不會一次轉過頭', overshoot === 0, overshoot + ' 幀衝過頭');

  /* 3. 髮夾：落後很多時上限要放寬，不然永遠追不上 */
  cam = { h: 0, rate: 0 };
  for (let i = 0; i < 240; i++) Render.stepCamYaw(cam, 2.4, DT, 0.30);
  ok('落後很多時追得回來', Math.abs(un(2.4 - cam.h)) < 0.05,
    '還差 ' + (Math.abs(un(2.4 - cam.h)) * 180 / Math.PI).toFixed(1) + ' 度');

  /* 4. 到位之後要停住，不可以在死區裡來回晃 */
  cam = { h: 0, rate: 0 };
  for (let i = 0; i < 300; i++) Render.stepCamYaw(cam, 0.5, DT, 0.30);
  const settled = cam.h;
  for (let i = 0; i < 60; i++) Render.stepCamYaw(cam, 0.5, DT, 0.30);
  ok('停下來之後不再抖', Math.abs(cam.h - settled) < 1e-6 && Math.abs(cam.rate) < 1e-6);

  /* 5. 跨過 ±180 度不可以整個翻半圈 */
  cam = { h: Math.PI - 0.05, rate: 0 };
  let flip = 0;
  for (let i = 0; i < 120; i++) {
    const before = cam.h;
    Render.stepCamYaw(cam, -Math.PI + 0.05, DT, 0.30);
    if (Math.abs(un(cam.h - before)) > 0.2) flip++;
  }
  ok('跨過 ±180 度不會翻半圈', flip === 0 && Math.abs(un(cam.h - (-Math.PI + 0.05))) < 0.05);
}
ok('太近的對手與場景物件會淡出或不畫', /淡出/.test(app));
ok('畫面跟不上時會自動關掉純裝飾的特效', /updateQuality/.test(app) && /G\.lite/.test(app));

/* ---------- 圖示 ---------- */
const svgui = read('public/js/svgui.js');
for (const name of ['gearIcon', 'closeIcon', 'arrowIcon', 'flagIcon', 'starIcon', 'settingIcon', 'itemIcon']) {
  ok('有 ' + name, svgui.includes('function ' + name));
}
ok('左右箭頭互為鏡像且置中', svgui.includes("'M34 10 14 24 34 38z'") && svgui.includes("'M14 10 34 24 14 38z'"));
ok('選角與結算用的 SVG 毛毛蟲還在', /function wormSvg/.test(render));

/* ---------- 急彎路面：實際走投影與多邊形繪製路徑 ---------- */
function cross(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}
function crossed(a, b, c, d) {
  return cross(a, b, c) * cross(a, b, d) < -1e-6 &&
    cross(c, d, a) * cross(c, d, b) < -1e-6;
}
for (const id of ['garden', 'candy', 'snow']) {
  const track = Tracks.get(id);
  let folds = 0, behind = 0;
  for (let i = 0; i < track.nodes.length; i += 7) {
    const nd = track.nodes[i];
    const cam = { x: nd.x - nd.tx * 155, y: nd.y - nd.ty * 155,
      a: Math.atan2(nd.ty, nd.tx), z: 80 };
    const P = Render.projector({ w: 1280, h: 720 }, cam);
    const pt = P.pt;
    P.pt = (x, y, z) => {
      if (P.fwd(x, y) < Render.NEAR - 1e-5) behind++;
      return pt(x, y, z);
    };
    const faces = [];
    Render.trackFaces(P, track, i, { road: '#aaa', roadEdge: '#fff' }, faces);
    let vertices = [];
    const ctx = {
      beginPath() { vertices = []; },
      moveTo(x, y) { vertices.push([x, y]); },
      lineTo(x, y) { vertices.push([x, y]); },
      closePath() {},
      fill() {
        for (let k = 0; k < vertices.length; k++) {
          for (let j = k + 2; j < vertices.length; j++) {
            if (k === 0 && j === vertices.length - 1) continue;
            if (crossed(vertices[k], vertices[(k + 1) % vertices.length],
              vertices[j], vertices[(j + 1) % vertices.length])) folds++;
          }
        }
      }
    };
    for (const face of faces) { face.edge(ctx); face.road(ctx); }
  }
  ok(id + ' 急彎路面不交叉，路緣不投影到鏡頭後方',
    folds === 0 && behind === 0, folds + ' 個交叉、' + behind + ' 個鏡頭後方頂點');
}

console.log('\n美術資產：' + pass + ' 通過，' + fail + ' 失敗');
process.exit(fail ? 1 : 0);
