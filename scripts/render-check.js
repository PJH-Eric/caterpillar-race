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
ok('鏡頭偏航就是車頭角，沒有別的來源', app.includes('const axis = me.angle;') &&
  !app.includes('camTargetAngle') && !app.includes('chaseAxis'));
ok('鏡頭用平滑過的行進方向退到後面', /cam\.h/.test(app));
ok('鏡頭位置與偏航用同一個軸線（毛毛蟲永遠釘在畫面正中央）',
  /G\.cam\.a = G\.cam\.h/.test(app) && /Math\.cos\(G\.cam\.h\) \* back/.test(app));
ok('鏡頭位置不做額外平滑（不然毛毛蟲會忽大忽小）', !/G\.cam\.x \+=/.test(app));
/* me.speed 是 hypot，永遠正的 —— 拿它捲地面條紋，後退時條紋會反著動 */
ok('地面條紋用「沿鏡頭方向的速度分量」，後退才會倒著捲',
  app.includes('me.vx * Math.cos(G.cam.h)') && !app.includes('+ me.speed * dt'));
/* 畫面轉多快由車本身的轉向速度決定，不是鏡頭端限速 ——
 * 實測鏡頭限速從 54 降到 14 度/秒，持續過彎的尖峰只從 119 掉到 113，
 * 落後卻從 25 度爆到 94 度。彎要轉的總角度是賽道給的，鏡頭遲早要轉完。 */
{
  const C = require('../public/js/rules.js').C;
  const peak = C.TURN * (1 - C.TURN_SPEED_FALLOFF) * 180 / Math.PI;
  ok('高速時畫面最快轉速在可接受範圍（會暈的是這個數字）', peak < 115,
    peak.toFixed(0) + ' 度/秒');
  ok('轉向速度還夠過彎（太低會有賽道過不去）', C.TURN >= 2.2, C.TURN);
}

/* ---------- 鏡頭：鎖死在車頭上，而且不可設定 ---------- */
{
  const html = read('public/index.html');
  const store = read('public/js/storage.js');

  /* 鏡頭只有一種，設定裡不該再有任何鏡頭跟隨／轉速的選項 */
  ok('設定裡沒有鏡頭跟隨的選項', !html.includes('set-cam"') && !store.includes('camMode:'));
  ok('設定裡沒有鏡頭轉動速度的選項',
    !html.includes('set-camspeed') && !store.includes('camTurnSpeed:'));
  ok('鏡頭遠近還留著（會暈的人唯一的緩解手段）', html.includes('set-zoom'));
  ok('舊存檔裡的鏡頭設定會被清掉', store.includes('delete raw.camMode'));
  {
    const S = require('../public/js/storage.js').Store;
    const withStore = raw => {
      global.localStorage = { _v: raw === null ? null : JSON.stringify(raw),
        getItem() { return this._v; }, setItem(k, x) { this._v = x; } };
      return S.load();
    };
    const old = withStore({ camMode: 'chase', camTurnSpeed: 2, nickname: 'Eric' });
    ok('舊存檔的鏡頭鍵清乾淨了', old.camMode === undefined && old.camTurnSpeed === undefined);
    ok('清鏡頭設定不會動到其他設定', old.nickname === 'Eric');
    ok('設定檔版本往上帶', old.v === 3, old.v);
    delete global.localStorage;
  }

  ok('鏡頭走 headCamYaw', app.includes('root.Render.headCamYaw('));
  ok('鏡頭沒有可調的轉速上限了', typeof Render.HEAD_CAM_RATE === 'undefined');

  /* 30Hz 物理 + 60Hz 繪製：鏡頭不能一格一格地頓，也不能落在車頭後面 */
  const un = a => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };
  const TICK = 1 / 30, FRAME = 1 / 60;
  const deg = r => (r * 180 / Math.PI).toFixed(1);

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
        maxLag = Math.max(maxLag, Math.abs(un(angle + turnVel * acc - h)));
      }
      prevStep = step;
    }
    /* 放開方向鍵之後要追得回來 */
    for (let f = 0; f < 240; f++) h = Render.headCamYaw(h, angle, 0, FRAME);
    return { judder, maxLag, settled: Math.abs(un(angle - h)) };
  }

  /* 一般過彎（實測車頭角速度中位 16、九成 60 度/秒） */
  const normal = sweep(0.5, 600);
  ok('一般過彎時鏡頭貼著車頭', normal.maxLag < 0.04, '最多落後 ' + deg(normal.maxLag) + ' 度');
  ok('一般過彎時畫面不會一格一格地頓',
    normal.judder < 0.02, '每幀轉動差 ' + deg(normal.judder) + ' 度');

  /* 滿舵：現在的 C.TURN 上限 */
  const C = require("../public/js/rules.js").C;
  const fast = sweep(C.TURN * (1 - C.TURN_SPEED_FALLOFF), 600);
  /* 滿舵時會落後，那是限速換來的 —— 但要有上限，而且看起來要像甩尾不像壞掉 */
  ok('滿舵時的落後在看得下去的範圍', fast.maxLag < 0.40, '最多落後 ' + deg(fast.maxLag) + ' 度');
  /* 關鍵的一條：九成的彎（60 度/秒）不能碰到限速，不然一般過彎就看得出歪掉 */
  const ninety = sweep(1.05, 600);
  ok('九成的彎碰不到限速（一般過彎時鏡頭就是鎖在車頭上）',
    ninety.maxLag < 0.06, '最多落後 ' + deg(ninety.maxLag) + ' 度');
  ok('限速仍然高於一般過彎、低於滿舵（只砍急甩那一下）',
    Render.HEAD_CAM.maxRate > 1.05 && Render.HEAD_CAM.maxRate < C.TURN * (1 - C.TURN_SPEED_FALLOFF),
    Render.HEAD_CAM.maxRate);
  ok('滿舵時畫面不會一格一格地頓', fast.judder < 0.02, '每幀轉動差 ' + deg(fast.judder) + ' 度');
  ok('轉完之後鏡頭停在車頭上', fast.settled < 0.01, '還差 ' + deg(fast.settled) + ' 度');

  const slow = sweep(0, 300);
  ok('不轉方向時鏡頭完全不動', slow.judder < 1e-9 && slow.maxLag < 1e-9);

  /* ---- 轉動時壓暗邊緣：砍周邊視覺的流動，中間不能動 ---- */
  ok('有轉動時的邊緣壓暗', typeof Render.drawSwayShade === 'function');
  {
    const S = Render.SWAY;
    ok('壓暗有起始與飽和的轉速門檻', S.from > 0 && S.to > S.from, JSON.stringify(S));
    /* 直線上絕對不能壓暗 —— 那會變成「整場都有一圈黑框」 */
    let drew = 0;
    const ctx = {
      save() {}, restore() {}, fillRect() { drew++; },
      createRadialGradient() { return { addColorStop() {} }; }
    };
    const P = { view: { w: 1280, h: 720 } };
    Render.drawSwayShade(ctx, P, 0);
    ok('不轉方向時完全不壓暗', drew === 0, drew);
    Render.drawSwayShade(ctx, P, S.from * 0.9);
    ok('轉得慢也不壓暗（一般過彎不該有黑框）', drew === 0, drew);
    Render.drawSwayShade(ctx, P, S.to);
    ok('轉得快才壓暗', drew > 0, drew);

    /* 中間要留一大塊完全不動，不然就不是「壓邊緣」而是「整個變暗」 */
    let inner = null;
    const ctx2 = {
      save() {}, restore() {}, fillRect() {},
      createRadialGradient(x0, y0, r0) { inner = r0; return { addColorStop() {} }; }
    };
    Render.drawSwayShade(ctx2, P, S.to);
    ok('中間留一大塊不壓暗（內圈至少佔短邊三分之一）',
      inner !== null && inner >= Math.min(P.view.w, P.view.h) * 0.33,
      '內圈半徑 ' + inner);

    /* 起始門檻要在「一般過彎」之上：實測中位 16°/s、九成 60°/s */
    const fromDeg = S.from * 180 / Math.PI;
    ok('壓暗的門檻在一般過彎之上（中位 16 度/秒）', fromDeg > 20,
      fromDeg.toFixed(0) + ' 度/秒');
  }
  ok('壓暗用的是鏡頭實際轉速，不是車頭角速度',
    app.includes('G.swayRate') && app.includes('G.cam.h - prevH'));
  ok('壓暗的量有平滑（不然會跟著單幀抖動閃）', app.includes('* 0.22'));

  /* 前饋量要跟濾波的時間常數配起來，不然不是落後就是超前 */
  ok('前饋量與濾波時間常數相當',
    Math.abs(Render.HEAD_CAM.lead - Render.HEAD_CAM.tau) < Render.HEAD_CAM.tau * 0.5,
    'lead=' + Render.HEAD_CAM.lead + ' tau=' + Render.HEAD_CAM.tau);
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
    for (const k of ['water', 'waterLip', 'slopeUp', 'slopeDown']) {
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

  const render = read('public/js/render.js');
  ok('坡上有人字箭頭', /function chevron/.test(render));
  ok('水坑跟泥巴畫法不一樣（不然只是換色的泥巴）', /waterLip/.test(render));

  const app = read('public/js/app.js');
  ok('箭頭有獨立的繪製階段', app.includes('face.chevron(ctx)'));
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
  const KINDS = ['left', 'right', 'sturn', 'up', 'down', 'water'];

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
  ok('六種標誌的圖示兩兩都不同',
    new Set(KINDS.map(k => pics[k].cx.toFixed(2) + ',' + pics[k].cy.toFixed(2))).size === KINDS.length);
  /* 不認得的種類要有退路，不能什麼都不畫 */
  ok('沒見過的標誌種類會畫驚嘆號當退路', pictogram('nonesuch').draws >= 3);
  /* ---- 標誌左右的判準：世界的轉向怎麼對應到畫面的左右 ----
   *
   * 這是整組標誌唯一指錯會害到玩家的地方，而且它壞過一次
   *（89 塊裡 64 塊指反），所以要有回歸測試。
   *
   * 測的是「慣例」而不是逐塊比對。逐塊比對做不到：
   * 畫面上的 x = halfW + r * focal/f，近的點乘上大很多的 s，
   * 所以「近處微微往左、遠處大幅往右」的複合彎，比較近端與遠端的螢幕 x
   * 會得到「往左」——那不是牌子錯，是那個量法把橫向位移與透視縮放混在一起了。
   * 一個彎往哪邊轉的定義就是淨轉向量，程式碼用的也是它（netTurn）。
   *
   * 所以這裡用一條合成的彎把慣例釘死：世界逆時針（外積為正）在畫面上
   * 一定是往右。這條一翻，tracks.js 的 netTurn 正負就要跟著翻。
   */
  {
    /* 合成一段往世界逆時針彎的路，鏡頭放在起點後面朝彎口看 */
    const R0 = 400;
    const arc = [];
    for (let k = 0; k <= 24; k++) {
      const th = k * 0.035;                       /* 逆時針 */
      arc.push({ x: Math.sin(th) * R0, y: R0 - Math.cos(th) * R0 });
    }
    /* 起點的切線是 +x，所以鏡頭朝 +x */
    const P3 = Render.projector({ w: 1280, h: 720 },
      { x: -140, y: 0, z: 62, a: 0, fov: 1 });
    /* 外積：起點切線 (1,0) → 末端切線 */
    const t1 = { x: 1, y: 0 };
    const last = arc[arc.length - 1], prev = arc[arc.length - 2];
    const dl = Math.hypot(last.x - prev.x, last.y - prev.y) || 1;
    const t2 = { x: (last.x - prev.x) / dl, y: (last.y - prev.y) / dl };
    const cross = t1.x * t2.y - t1.y * t2.x;
    ok('合成的彎確實是世界逆時針（外積為正）', cross > 0, cross.toFixed(3));

    /* 這段路在畫面上往哪邊？用角度 r/f（透視正規化過，不會被近點放大） */
    let ang = 0, cnt = 0;
    for (const q of arc) {
      const f = P3.fwd(q.x, q.y);
      if (f < 150) continue;
      const r = -(q.x - P3.cam.x) * P3.sin + (q.y - P3.cam.y) * P3.cos;
      if (Math.abs(r) / f > 1.9) break;
      ang += r / f; cnt++;
    }
    ok('量得到足夠的取樣', cnt >= 8, cnt);
    ok('世界逆時針的彎，在畫面上是往右（標誌左右的判準）', ang / cnt > 0,
      '平均水平角 ' + (Math.atan(ang / cnt) * 180 / Math.PI).toFixed(1) + ' 度');

    /* tracks.js 就是照這條慣例決定 left／right 的 */
    const tracksSrc = read('public/js/tracks.js');
    ok('tracks.js 用淨轉向量決定左右，而且註明了外積為正＝畫面右',
      tracksSrc.includes('function netTurn') &&
      tracksSrc.includes('外積為正＝世界逆時針＝畫面上往右') &&
      tracksSrc.includes("t.net < 0 ? 'left' : 'right'"));
    ok('幾乎打直的路不立左右轉的牌子', tracksSrc.includes('TURN_MIN_NET'));
    ok('複合彎不立左右轉的牌子（會指錯）', tracksSrc.includes('TURN_MAX_OPPOSITE'));

    /* 每一塊左右轉的牌子，前面那段路的淨轉向都要夠大而且方向一致 */
    const Tracks3 = require('../public/js/tracks.js');
    let total = 0, bad = [];
    for (const def of Tracks3.TRACKS) {
      const t = Tracks3.build(def);
      const n = t.nodes.length;
      const at = i => t.nodes[t.open ? Math.max(0, Math.min(n - 1, i)) : ((i % n) + n) % n];
      for (const sg of t.signs) {
        if (sg.kind !== 'left' && sg.kind !== 'right') continue;
        total++;
        let net = 0, pos = 0, neg = 0;
        for (let k = 6; k < 44; k++) {
          const a = at(sg.node + k), b = at(sg.node + k + 1);
          const d = Math.atan2(a.tx * b.ty - a.ty * b.tx, a.tx * b.tx + a.ty * b.ty);
          net += d; if (d > 0) pos += d; else neg -= d;
        }
        const want = net < 0 ? 'left' : 'right';
        if (want !== sg.kind) bad.push(def.id + '@' + sg.node + ' 寫 ' + sg.kind + ' 淨轉向 ' + (net * 180 / Math.PI).toFixed(0) + '度');
        else if (Math.abs(net) < 0.28) bad.push(def.id + '@' + sg.node + ' 路太直（' + (net * 180 / Math.PI).toFixed(0) + '度）還立了牌');
        else if (Math.min(pos, neg) > 0.16) bad.push(def.id + '@' + sg.node + ' 是複合彎還立了左右轉');
      }
    }
    ok('每塊左右轉標誌的方向都跟前方淨轉向一致', bad.length === 0,
      bad.length + '/' + total + '：' + bad.slice(0, 3).join('; '));
    ok('有足夠的左右轉標誌可以驗', total > 40, total + ' 塊');
  }

  const render = read('public/js/render.js');
  ok('標誌牌面正面朝鏡頭（轉過去斜看就只剩一條線）', /billboard/.test(render));
  ok('標誌太遠就不畫圖示（只剩彩色牌面）', /r < 7/.test(render));
  ok('標誌有類型配色、雙層邊框與反光', /SIGN_PALETTE/.test(render) &&
    /createLinearGradient/.test(render) && /fillRect\(bx - r/.test(render));
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
