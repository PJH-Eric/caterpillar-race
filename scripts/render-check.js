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
  ok('head 模式走 headCamYaw，不走賽道前瞻那套阻尼器',
    app.includes('headCamYaw(') && !app.includes('CAM_YAW_LERP.head'));
  ok('鏡頭轉動速度是可以調的', /set-camspeed/.test(html) && /camTurnSpeed/.test(store) &&
    app.includes('HEAD_CAM_RATE[G.settings.camTurnSpeed]'));
  ok('鏡頭轉動速度三段由慢到快', Render.HEAD_CAM_RATE.length === 3 &&
    Render.HEAD_CAM_RATE[0] < Render.HEAD_CAM_RATE[1] && Render.HEAD_CAM_RATE[1] < Render.HEAD_CAM_RATE[2]);
  ok('預設那一段就是 HEAD_CAM.maxRate',
    Render.HEAD_CAM_RATE[1] === Render.HEAD_CAM.maxRate);

  /* 30Hz 物理 + 60Hz 繪製：鏡頭不能一格一格地頓，也不能落在車頭後面 */
  const un = a => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };
  const TICK = 1 / 30, FRAME = 1 / 60;
  /* warm＝前幾幀不列入統計。量「短彎的尖峰」時要連起步那一下一起看，就傳 0。 */
  function sweep(rate, frames, cap, warm) {
    if (warm === undefined) warm = 30;
    let angle = 0, turnVel = 0, acc = 0, h = 0;
    let judder = 0, maxLag = 0, peakRate = 0, prevStep = 0;
    let lagMid = 0, lagEnd = 0;
    for (let f = 0; f < frames; f++) {
      acc += FRAME;
      while (acc >= TICK) { turnVel = rate; angle = un(angle + turnVel * TICK); acc -= TICK; }
      const before = h;
      h = Render.headCamYaw(h, angle, turnVel, FRAME, cap);
      const step = Math.abs(un(h - before));
      const lag = Math.abs(un(angle + turnVel * acc - h));   /* 對次刻度後的真實車頭角 */
      if (f > warm) {
        judder = Math.max(judder, Math.abs(step - prevStep));
        maxLag = Math.max(maxLag, lag);
        peakRate = Math.max(peakRate, step / FRAME);
      }
      if (f === Math.floor(frames / 2)) lagMid = lag;
      if (f === frames - 1) lagEnd = lag;
      prevStep = step;
    }
    /* 放開方向鍵之後，鏡頭要追得回來 */
    turnVel = 0;
    for (let f = 0; f < 240; f++) h = Render.headCamYaw(h, angle, 0, FRAME, cap);
    return { judder, maxLag, peakRate, lagGrowth: lagEnd - lagMid,
      settled: Math.abs(un(angle - h)) };
  }
  const CAP = Render.HEAD_CAM.maxRate;
  const deg = r => (r * 180 / Math.PI).toFixed(1);

  /* 一般過彎（實測中位 16°/s、九成 65°/s）——這一段要完全感覺不到限速 */
  const normal = sweep(0.5, 600);   /* 29°/s */
  ok('head 模式一般過彎時鏡頭還是貼著車頭（限速碰不到）',
    normal.maxLag < 0.04, '最多落後 ' + deg(normal.maxLag) + ' 度');
  ok('head 模式一般過彎時畫面不會一格一格地頓',
    normal.judder < 0.02, '每幀轉動差 ' + deg(normal.judder) + ' 度');

  /* 會暈的是「突然甩一下」，不是整場。限速砍的就是這一段 ——
   * 注意限速砍不掉「一直轉下去」的轉速：彎要轉過去的總角度是賽道決定的，
   * 鏡頭遲早要轉完，不然就是愈落愈後面。所以這裡量的是短彎的尖峰。 */
  const SHORT = Math.round(0.4 / FRAME);
  const capped = sweep(2.0, SHORT, 0, 0);
  const loose = sweep(2.0, SHORT, 99, 0);     /* 同一個彎，但上限高到等於沒限速 */
  ok('head 模式短彎的尖峰轉速真的被砍下來',
    capped.peakRate < loose.peakRate * 0.72,
    deg(loose.peakRate) + '°/s → ' + deg(capped.peakRate) + '°/s');
  ok('「慢一點」砍得比「普通」多',
    sweep(2.0, SHORT, Render.HEAD_CAM_RATE[0], 0).peakRate < capped.peakRate);

  /* 限速買到的平順是拿「落後」換的，落後不能大到看起來像壞掉 */
  const fast = sweep(2.4, 600);
  ok('head 模式就算一路打死方向，落後也在看得下去的範圍',
    fast.maxLag < 0.9, '最多落後 ' + deg(fast.maxLag) + ' 度');
  ok('head 模式打死方向時畫面不會一格一格地頓',
    fast.judder < 0.02, '每幀轉動差 ' + deg(fast.judder) + ' 度');
  /* 限速一定要配 lagBoost，不然髮夾彎會愈落愈後面、永遠追不回來 */
  ok('head 模式的落後會收斂，不會愈落愈遠',
    fast.lagGrowth < 0.02, '後半段還在擴大 ' + deg(fast.lagGrowth) + ' 度');
  ok('head 模式轉完之後鏡頭追得回車頭',
    fast.settled < 0.01, '停手後還差 ' + deg(fast.settled) + ' 度');

  const slow = sweep(0, 300);
  ok('head 模式不轉方向時鏡頭完全不動', slow.judder < 1e-9 && slow.maxLag < 1e-9);

  /* 調慢那一段要真的比較慢，調快那一段要真的比較快 */
  const slowCap = sweep(2.4, 600, Render.HEAD_CAM_RATE[0]);
  const fastCap = sweep(2.4, 600, Render.HEAD_CAM_RATE[2]);
  ok('「慢一點」轉得比「普通」慢、「快一點」轉得比「普通」快',
    slowCap.peakRate < fast.peakRate && fast.peakRate < fastCap.peakRate,
    [slowCap, fast, fastCap].map(r => deg(r.peakRate) + '°/s').join(' < '));

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

/* ---------- 賽道機制的畫面 ---------- */
{
  const TrackArt = require('../public/js/themes/tracks-art.js');
  const themes = TrackArt.THEMES;

  /* 每套主題都要推得出新地形的顏色，而且不能推成跟路面一樣（那就等於看不見） */
  const same = [], missing = [];
  for (const id in themes) {
    const c = Render.surfaceColors(themes[id]);
    for (const k of ['water', 'waterLip', 'slopeUp', 'slopeDown', 'wall', 'wallDark', 'roof']) {
      if (!/^#[0-9a-f]{6}$/i.test(c[k] || '')) missing.push(id + '.' + k);
    }
    if (c.slopeUp === themes[id].road || c.slopeDown === themes[id].road) same.push(id);
  }
  ok('每套主題都推得出新地形的顏色', missing.length === 0, missing.slice(0, 4).join(', '));
  ok('上下坡的路面色跟平路不一樣（不然玩家看不出來是坡）', same.length === 0, same.join(', '));

  /* 上坡要比平路暗、下坡要比平路亮 —— 這是玩家唯一的視覺線索 */
  const lum = h => {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  let wrongWay = [];
  for (const id in themes) {
    const c = Render.surfaceColors(themes[id]);
    if (!(lum(c.slopeUp) < lum(themes[id].road) && lum(c.slopeDown) > lum(themes[id].road))) wrongWay.push(id);
  }
  ok('上坡比平路暗、下坡比平路亮', wrongWay.length === 0, wrongWay.join(', '));

  /* 隧道的牆一定要比路面暗，不然「進洞」讀不出來 */
  let bright = [];
  for (const id in themes) {
    const c = Render.surfaceColors(themes[id]);
    if (lum(c.roof) >= lum(c.wall)) bright.push(id);
  }
  ok('隧道頂比側牆暗', bright.length === 0, bright.join(', '));

  const render = read('public/js/render.js');
  ok('隧道有牆也有天花板', /function tunnel/.test(render) && /TUNNEL_H/.test(render));
  ok('隧道淨高高過鏡頭（不然鏡頭會穿出天花板）', Render.HEAD_CAM && /TUNNEL_H = 9/.test(render));
  ok('坡上有人字箭頭', /function chevron/.test(render));
  ok('進隧道會壓暗畫面', typeof Render.drawTunnelShade === 'function');
  ok('水坑跟泥巴畫法不一樣（不然只是換色的泥巴）', /waterLip/.test(render));

  const app = read('public/js/app.js');
  ok('箭頭與隧道有各自的繪製階段', app.includes('face.chevron(ctx)') && app.includes('face.tunnel(ctx)'));
  ok('隧道明暗用鏡頭的節點算，不是毛毛蟲的', app.includes('nodeAt(tr, G.cam.x, G.cam.y, me.node)'));

  /* 隧道的牆真的畫在路面外、頂真的在上面 */
  const Tracks2 = require('../public/js/tracks.js');
  const tk = Tracks2.get('garden', 's');
  let tunnelNode = -1;
  for (let i = 0; i < tk.nodes.length; i++) if (tk.inTunnel[i]) { tunnelNode = i; break; }
  ok('garden 有隧道區段', tunnelNode >= 0);
  if (tunnelNode >= 0) {
    const nd = tk.nodes[tunnelNode];
    const cam = { x: nd.x - nd.tx * 150, y: nd.y - nd.ty * 150,
      a: Math.atan2(nd.ty, nd.tx), z: 62, fov: 1 };
    const P = Render.projector({ w: 1280, h: 720 }, cam);
    const faces = [];
    Render.trackFaces(P, tk, tunnelNode, themes.garden, faces);
    const withTunnel = faces.filter(f => f.tunnel);
    ok('隧道區段會產生牆與頂的繪製', withTunnel.length > 0, withTunnel.length + ' 段');

    /* 把頂畫出來，量它在畫面上的位置：必須在地平線上方 */
    let topY = Infinity, drew = 0;
    const ctx = {
      save() {}, restore() {}, beginPath() {}, closePath() {}, fill() { drew++; },
      stroke() {}, moveTo(x, y) { topY = Math.min(topY, y); },
      lineTo(x, y) { topY = Math.min(topY, y); },
      createRadialGradient() { return { addColorStop() {} }; },
      createLinearGradient() { return { addColorStop() {} }; },
      ellipse() {}, arc() {}, fillRect() {}, quadraticCurveTo() {}, setLineDash() {}
    };
    for (const f of withTunnel) f.tunnel(ctx);
    ok('隧道真的有畫出東西', drew > 0, drew + ' 個面');
    ok('隧道頂畫在地平線上方（人在洞裡，頂在頭上）',
      topY < P.horizon, '頂 y=' + topY.toFixed(0) + '，地平線 y=' + P.horizon.toFixed(0));
  }
}

/* ---------- 城市賽道的美術 ---------- */
{
  const TrackArt = require('../public/js/themes/tracks-art.js');
  const render = read('public/js/render.js');
  for (const id of ['city', 'highway', 'cityNight']) {
    ok('有 ' + id + ' 主題', !!TrackArt.THEMES[id]);
  }
  ok('夜間街道是夜晚主題', TrackArt.THEMES.cityNight.night === true);
  ok('城市的路面是灰的（不是泥土色）', (() => {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(TrackArt.THEMES.city.road.slice(i, i + 2), 16));
    return Math.max(r, g, b) - Math.min(r, g, b) < 30;     /* 彩度很低＝灰 */
  })());
  ok('有大樓、路燈、三角錐三種城市景物',
    /k === 'building'/.test(render) && /k === 'lamp'/.test(render) && /k === 'cone'/.test(render));
  ok('大樓算高的景物（要離路邊遠一點，不然擋住賽道）', /building: 1/.test(render));
  ok('三種城市主題都有自己的景物清單',
    render.includes("city: ['building'") && render.includes("cityNight: ['building'") && render.includes("highway: ['lamp'"));
}

/* ---------- 交通標誌 ---------- */
{
  const TrackArt = require('../public/js/themes/tracks-art.js');
  const theme = TrackArt.THEMES.garden;
  const KINDS = ['left', 'right', 'sturn', 'tunnel', 'up', 'down', 'water'];

  /* 只量牌面上的圖示：桿子與牌框是對稱的，會把左右差異洗掉。
   * 第一次 stroke 是桿子、第二次是牌框，之後畫的才是圖示。 */
  function pictogram(kind) {
    let sx = 0, sy = 0, n = 0, strokes = 0, draws = 0;
    const note = (x, y) => { if (strokes < 1) return; sx += x; sy += y; n++; };
    const ctx = {
      save() {}, restore() {}, beginPath() {}, closePath() {},
      fill() { draws++; }, stroke() { strokes++; draws++; },
      moveTo: note, lineTo: note,
      bezierCurveTo(a, b, c, d, e, f) { note(a, b); note(c, d); note(e, f); },
      quadraticCurveTo(a, b, c, d) { note(a, b); note(c, d); },
      arc(x, y) { note(x, y); },
      ellipse() {}, fillRect() {}, setLineDash() {},
      createRadialGradient() { return { addColorStop() {} }; },
      createLinearGradient() { return { addColorStop() {} }; }
    };
    Render.drawProp(ctx, { kind: 'sign', sign: kind, h: 1, seed: 0.5 }, 400, 300, 1, theme, 0);
    return { cx: n ? sx / n : 0, cy: n ? sy / n : 0, n: n, draws: draws };
  }

  const pics = {};
  for (const k of KINDS) pics[k] = pictogram(k);

  ok('每一種標誌都畫得出圖示', KINDS.every(k => pics[k].n >= 4 && pics[k].draws >= 3),
    KINDS.filter(k => pics[k].n < 4).join(', '));
  /* 方向錯的標誌比沒有標誌更糟 —— 玩家會照著它轉錯邊 */
  ok('左轉標誌的箭頭偏左、右轉偏右',
    pics.left.cx < 399 && pics.right.cx > 401,
    '左 ' + pics.left.cx.toFixed(1) + '／右 ' + pics.right.cx.toFixed(1));
  ok('左轉與右轉互為鏡像',
    Math.abs((400 - pics.left.cx) - (pics.right.cx - 400)) < 0.5);
  ok('上坡與下坡的圖示不一樣', Math.abs(pics.up.cx - pics.down.cx) > 1);
  ok('七種標誌的圖示兩兩都不同',
    new Set(KINDS.map(k => pics[k].cx.toFixed(2) + ',' + pics[k].cy.toFixed(2))).size === KINDS.length);
  /* 不認得的種類要有退路，不能什麼都不畫 */
  ok('沒見過的標誌種類會畫驚嘆號當退路', pictogram('nonesuch').draws >= 3);

  const render = read('public/js/render.js');
  ok('標誌牌面正面朝鏡頭（轉過去斜看就只剩一條線）', /billboard/.test(render));
  ok('標誌太遠就不畫圖示（只剩一塊黃菱形）', /r < 7/.test(render));
  ok('標誌會跟著景物一起由遠到近畫', /kind: 'sign'/.test(render));
}

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
