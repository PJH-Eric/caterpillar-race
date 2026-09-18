/* ===== render.js — 真透視的追尾視角渲染器 =====
 *
 * 為什麼不是俯視了：俯視加上「鏡頭跟著車頭轉」會暈 —— 毛毛蟲一邊跑一邊左右擺，
 * 車頭本來就在抖，整個世界跟著抖。改成追尾視角之後地平線永遠水平，
 * 毛毛蟲在畫面前方扭來扭去，世界卻是穩的；順便也真的變成立體畫面。
 *
 * 投影：地面是 z = 0 的平面，鏡頭在毛毛蟲後上方。
 *   f = 前方距離、r = 右方距離、z = 離地高度
 *   螢幕 x = 畫面中央 + r * focal / f
 *   螢幕 y = 地平線   + (鏡頭高度 - z) * focal / f
 * f 越大越靠近地平線，這就是透視。賽道、毛毛蟲、樹、道具葉全部走同一組公式，
 * 所以不必維護兩套座標系，位置一定對得起來。
 *
 * 繪製一律由遠到近（畫家演算法），近的東西自然蓋住遠的。
 */
(function (root) {
  'use strict';

  const TAU = Math.PI * 2;

  /* ---------- 毛毛蟲身體 ---------- */
  /* 參考畫面裡的毛毛蟲是「緊湊的幾顆圓球」，不是一條長蟲，
   * 所以節數少一點、球大一點、間距近一點，剪影才對得上。 */
  const SEGS = 3;          /* 身體節數（不含頭） */
  const SEG_GAP = 10.5;    /* 節與節的距離（比直徑小，球才會互相疊住） */
  const HEAD_R = 16;
  /* 每一節都貼在地上，沒有任何一節浮起來。
   * 「站著而不是趴著」靠的是頭特別大、身體往後收得很快 ——
   * 剪影是一顆高高的大頭加一截小尾巴，不是一條等粗的香腸。
   * 之前改成斜斜往上疊過，那會讓頭懸在半空中，看起來就是飄的。 */
  const SEG_RUN = SEG_GAP;                             /* 每一節往後退多少（地面上） */
  const SEG_RISE = 0;                                  /* 不抬高，全部貼地 */
  function segRadius(i, scale) {
    return (i === 0 ? HEAD_R : HEAD_R * (0.70 - (i - 1) * 0.16)) * (scale || 1);
  }
  /** 第 i 節的球心高度＝自己的半徑，球的最低點剛好落在地面上 */
  function segHeight(i, scale) {
    return segRadius(i, scale);
  }

  /* ---------- 鏡頭與投影 ---------- */
  const NEAR = 26;         /* 比這更近就不畫（f 接近 0 時投影會飛出去幾萬像素） */
  const FAR = 2400;        /* 畫多遠 */
  const HORIZON = 0.33;    /* 地平線在畫面高度的幾成。壓低一點，路面才鋪滿畫面下面三分之二 */
  const GRASS_SPAN = 950;  /* 賽道兩側的草地畫多寬 */
  const RUMBLE = 13;       /* 緣石寬度 */
  const AHEAD_NODES = 100; /* 往前畫幾個節點（約 1400 個世界單位） */
  const BEHIND_NODES = 22;

  function makeCanvas(w, h) {
    const c = (typeof document !== 'undefined')
      ? document.createElement('canvas')
      : { width: w, height: h, getContext: () => null };
    c.width = w; c.height = h;
    return c;
  }

  /* ================================================================
   *  一、投影器（每一幀建立一次）
   * ================================================================ */

  function projector(view, cam) {
    const cos = Math.cos(cam.a), sin = Math.sin(cam.a);
    const horizon = view.h * HORIZON;
    /* focal 決定視角寬窄，跟畫面高度綁在一起，換裝置視野才一致。
     * 速度越快 focal 越小＝視角越廣，路邊的東西會更快地從兩側刷過去 ——
     * 這是賽車遊戲做速度感最有效的一招，而且完全不動物理。 */
    const focal = view.h * 0.95 * (cam.fov || 1);
    const halfW = view.w / 2;

    /** 世界座標 → 前方距離 */
    function fwd(wx, wy) { return (wx - cam.x) * cos + (wy - cam.y) * sin; }

    /** 世界座標 → 螢幕座標。f 是真實前方距離，s 是這個距離的縮放 */
    function pt(wx, wy, wz) {
      const dx = wx - cam.x, dy = wy - cam.y;
      const f = dx * cos + dy * sin;
      const r = -dx * sin + dy * cos;
      const cf = f < NEAR ? NEAR : f;
      const s = focal / cf;
      return { x: halfW + r * s, y: horizon + (cam.z - (wz || 0)) * s, s: s, f: f };
    }

    return { pt, fwd, horizon, focal, halfW, cos, sin, view, cam };
  }

  /* ================================================================
   *  二、天空、遠山與地面
   * ================================================================ */

  /* 天空與地面的漸層只跟「畫面高度 ＋ 主題」有關，每一幀重建純粹是浪費。
   * 快取起來之後，這兩個 createLinearGradient 一局只會發生幾次。 */
  const gradCache = { sky: null, ground: null, key: '' };
  function cachedGrads(ctx, P, theme) {
    const key = P.view.w + 'x' + P.view.h + '|' + theme.sky2 + theme.skyLow + theme.grass + theme.grassDark;
    if (gradCache.key !== key) {
      const hz = P.horizon, v = P.view;
      const sg = ctx.createLinearGradient(0, 0, 0, hz);
      sg.addColorStop(0, theme.sky2);
      sg.addColorStop(1, theme.skyLow);
      const gg = ctx.createLinearGradient(0, hz, 0, v.h);
      gg.addColorStop(0, theme.grassDark);
      gg.addColorStop(0.16, theme.grass);
      gg.addColorStop(1, theme.grass);
      gradCache.sky = sg; gradCache.ground = gg; gradCache.key = key;
    }
    return gradCache;
  }

  function drawSky(ctx, P, theme, t, lite) {
    const v = P.view, hz = P.horizon;

    ctx.fillStyle = cachedGrads(ctx, P, theme).sky;
    ctx.fillRect(0, 0, v.w, hz + 1);

    /* 太陽／月亮綁在世界的某個方位，鏡頭一轉它就跟著移，才有「在世界裡」的感覺 */
    let rel = 2.1 - P.cam.a;
    while (rel > Math.PI) rel -= TAU;
    while (rel < -Math.PI) rel += TAU;
    if (Math.abs(rel) < 1.5 && !lite) {
      const sx = P.halfW + rel * P.focal * 0.55;
      const sy = hz * 0.34;
      const sr = v.h * 0.05;
      const sg = ctx.createRadialGradient(sx, sy, sr * 0.2, sx, sy, sr * 3);
      sg.addColorStop(0, theme.sun);
      sg.addColorStop(0.24, theme.sun);
      sg.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = sg;
      ctx.beginPath(); ctx.arc(sx, sy, sr * 3, 0, TAU); ctx.fill();
    }

    /* 兩層遠山。參考畫面裡的山是一顆一顆圓鼓鼓的包，不是連續起伏的曲線，
     * 所以直接沿著地平線排半圓，深的那層在後面、淺的在前面，視差不同，
     * 轉彎時看得出自己在轉。 */
    for (let layer = 0; layer < 2; layer++) {
      const depth = layer === 0 ? 0.30 : 0.52;
      const base = hz + (layer === 0 ? 1 : v.h * 0.012);
      const amp = v.h * (layer === 0 ? 0.085 : 0.055);
      const step = v.h * (layer === 0 ? 0.21 : 0.135);
      const off = -P.cam.a * P.focal * depth;
      ctx.fillStyle = layer === 0 ? theme.hillDark : theme.hill;
      ctx.beginPath();
      ctx.moveTo(-20, base + 8);
      /* 用世界方位算包的索引，鏡頭轉一圈才會接得回來 */
      const i0 = Math.floor((-20 + off) / step) - 1;
      const i1 = Math.ceil((v.w + 20 + off) / step) + 1;
      for (let i = i0; i <= i1; i++) {
        const cx = i * step - off;
        const h = amp * (0.62 + 0.38 * Math.sin(i * 1.7 + layer * 2.9));
        const w = step * (0.62 + 0.22 * Math.sin(i * 0.9 + layer));
        ctx.lineTo(cx - w, base + 8);
        ctx.quadraticCurveTo(cx - w * 0.52, base - h * 1.28, cx, base - h);
        ctx.quadraticCurveTo(cx + w * 0.52, base - h * 1.28, cx + w, base + 8);
      }
      ctx.lineTo(v.w + 20, base + 8);
      ctx.closePath();
      ctx.fill();
    }

    /* 地平線上壓一條草地色的橫帶，遠方才不是「山直接接到路」 */
    ctx.fillStyle = theme.grassDark;
    ctx.fillRect(0, hz - v.h * 0.004, v.w, v.h * 0.016);

    /* 幾朵雲（夜間主題換成星星）。低效能模式整段跳過。 */
    if (lite) return;
    if (theme.night) {
      ctx.fillStyle = 'rgba(255,255,255,.8)';
      for (let i = 0; i < 46; i++) {
        let r2 = (i * 0.618 % 1) * TAU - P.cam.a;
        while (r2 > Math.PI) r2 -= TAU;
        while (r2 < -Math.PI) r2 += TAU;
        if (Math.abs(r2) > 1.5) continue;
        ctx.globalAlpha = 0.3 + 0.55 * (((i * 13) % 10) / 10);
        ctx.beginPath();
        ctx.arc(P.halfW + r2 * P.focal * 0.5, ((i * 37) % 100) / 100 * hz * 0.82, 1.4, 0, TAU);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    } else {
      ctx.fillStyle = 'rgba(255,255,255,.72)';
      for (let i = 0; i < 6; i++) {
        let r2 = i * 1.05 + 0.4 - P.cam.a;
        while (r2 > Math.PI) r2 -= TAU;
        while (r2 < -Math.PI) r2 += TAU;
        if (Math.abs(r2) > 1.5) continue;
        const cx = P.halfW + r2 * P.focal * 0.42 + Math.sin(t * 0.05 + i) * 6;
        const cy = hz * (0.18 + 0.3 * ((i * 7) % 5) / 5);
        const cr = v.h * (0.018 + 0.012 * ((i * 3) % 4) / 4);
        for (const o of [[-1.1, 0.15, 0.7], [0, -0.2, 1], [1.1, 0.15, 0.75]]) {
          ctx.beginPath();
          ctx.arc(cx + cr * o[0] * 1.6, cy + cr * o[1], cr * o[2], 0, TAU);
          ctx.fill();
        }
      }
    }
  }

  /** 地面底色：地平線附近偏暗（大氣感），往下轉成草地色 */
  function drawGround(ctx, P, theme) {
    const v = P.view, hz = P.horizon;
    ctx.fillStyle = cachedGrads(ctx, P, theme).ground;
    ctx.fillRect(0, hz, v.w, v.h - hz);
  }

  /**
   * 地面的水平條紋：深淺草地交替，隨著前進往鏡頭方向捲過來。
   * 條紋只跟「離鏡頭多遠」有關，跟賽道怎麼繞無關，所以永遠不會蓋到賽道。
   * @param {number} dist 鏡頭累積跑過的距離，用來讓條紋會動
   */
  /** 地面紋理：在世界座標的格子上撒小點，投影下來就是近大遠小的地紋。
   * 沒有它的話，鏡頭壓低之後畫面下半是一大片純色，跑起來完全沒有速度感 ——
   * 參考畫面裡那層沙地顆粒做的就是這件事。 */
  const TEX_CELL = 64;
  const TEX_SPAN = 7;     /* 鏡頭四周各取幾格 */

  function drawGroundTexture(ctx, P, theme) {
    const v = P.view;
    const cx0 = Math.round(P.cam.x / TEX_CELL);
    const cy0 = Math.round(P.cam.y / TEX_CELL);
    ctx.save();
    ctx.fillStyle = theme.grassDark;
    ctx.globalAlpha = 0.16;
    for (let iy = -TEX_SPAN; iy <= TEX_SPAN; iy++) {
      for (let ix = -TEX_SPAN; ix <= TEX_SPAN; ix++) {
        const gx = cx0 + ix, gy = cy0 + iy;
        /* 便宜的雜湊，讓每格的點位固定在世界上（鏡頭動它不會跟著飄） */
        const h = ((gx * 73856093) ^ (gy * 19349663)) >>> 0;
        const wx = gx * TEX_CELL + (h % 59) - 29;
        const wy = gy * TEX_CELL + ((h >>> 8) % 59) - 29;
        const pt = P.pt(wx, wy, 0);
        if (pt.f < NEAR * 2 || pt.f > 1500) continue;
        if (pt.x < -40 || pt.x > v.w + 40 || pt.y < P.horizon || pt.y > v.h + 20) continue;
        const rx = Math.max(0.6, 9 * pt.s);
        if (rx < 0.8) continue;
        ctx.beginPath();
        ctx.ellipse(pt.x, pt.y, rx, Math.max(0.5, rx * 0.34), 0, 0, TAU);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  function drawGroundBands(ctx, P, theme, dist) {
    const v = P.view, hz = P.horizon;
    const BAND = 140;
    ctx.save();
    for (let f = 46; f < FAR; ) {
      const next = f * 1.22 + 8;
      const y0 = hz + P.cam.z * P.focal / Math.min(next, FAR);
      const y1 = hz + P.cam.z * P.focal / f;
      if (y1 < hz) break;
      if (y0 > v.h) { f = next; continue; }
      const idx = Math.floor((dist + f) / BAND);
      if (idx % 2 === 0) {
        ctx.fillStyle = theme.grassAlt;
        ctx.globalAlpha = 0.8;
        ctx.fillRect(0, y0, v.w, Math.max(1, y1 - y0));
      }
      f = next;
    }
    ctx.restore();
  }

  /**
   * 速度線：衝刺時從畫面兩側往後刷過去的白色弧線。
   * @param {number} amount 0～1，0 就什麼都不畫
   */
  function drawSpeedLines(ctx, P, amount, t) {
    if (amount <= 0.02) return;
    const v = P.view;
    ctx.save();
    ctx.globalAlpha = Math.min(0.55, amount * 0.55);
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineCap = 'round';
    for (let i = 0; i < 8; i++) {
      const seed = (i * 0.618) % 1;
      const side = i % 2 ? 1 : -1;
      const phase = ((t * 2.4 + seed) % 1);
      const spread = 0.18 + seed * 0.34;
      const x = v.w / 2 + side * v.w * (0.12 + spread * phase) * 1.35;
      const y = P.horizon + v.h * (0.1 + seed * 0.75);
      const len = v.w * 0.06 * (0.4 + phase);
      ctx.lineWidth = Math.max(1.5, v.h * 0.004 * (0.5 + phase));
      ctx.globalAlpha = Math.min(0.5, amount * 0.5 * (1 - Math.abs(phase - 0.5) * 1.2));
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + side * len, y + len * 0.22);
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ================================================================
   *  鏡頭偏航的阻尼器（放在這裡是為了讓測試可以直接跑它）
   *
   *  會暈的原因不是「轉」，是轉得又快又急又停不住。賽道現在很寬，鏡頭沒必要
   *  每個彎都整個甩過去：讓毛毛蟲在畫面裡歪個二三十度，前面的路一樣看得清楚，
   *  畫面卻穩很多。
   *
   *  三條規則，缺一個過彎就會怪：
   *    1. 轉速有上限，而且轉速本身也是平滑的（起轉、收轉都漸進）。
   *    2. 要反方向轉的時候必須馬上跟上 —— 慢慢收的話鏡頭會繼續往錯的方向
   *       再轉半秒，S 彎、髮夾出彎就會覺得鏡頭在亂轉。
   *    3. 絕不往離目標更遠的方向轉，也絕不一次轉過頭。
   * ================================================================ */
  const CAM_YAW = {
    maxRate: 0.44,      /* 每秒最多轉幾弧度（約 25 度／秒） */
    rateLerp: 0.085,    /* 轉速的平滑 */
    rateFlip: 0.42,     /* 要反方向轉時改用這個，快很多 */
    lagMax: 0.50,       /* 落後目標超過這麼多弧度（約 29 度）才放寬上限 */
    lagBoost: 3.5,      /* 超過之後每多一弧度，上限放寬幾倍 */
    dead: 0.014,        /* 角差小於這個就完全不轉，殘餘微抖直接消掉 */
    follow: 0.30        /* 想要的轉速＝角差的幾分之幾（換算成每秒） */
  };

  /**
   * head 模式的鏡頭偏航 ——「車頭指哪，畫面就看哪」。
   *
   * 跟 stepCamYaw 不一樣的是：不前瞻、不看行進方向，目標就是車頭角本身，
   * 所以鏡頭永遠不會自己轉，畫面只有在玩家轉方向的時候才跟著轉。
   *
   * 三件事：
   *   1. 一階濾波（時間常數 tau）—— 物理跑 30Hz、畫面畫 60Hz，直接把車頭角抄過來的話
   *      畫面轉動就是一格一格的（打死方向時一步 4.8 度，看得出來在頓）。
   *   2. 用角速度做前饋（lead）—— 濾波本來會讓鏡頭落後，但車頭的角速度是已知的
   *      （turnVel），補上去剛好把落後抵銷掉。實測落後比直接抄還小
   *      （最多 0.9 度 vs 2.4 度），同時平順五倍。
   *   3. 轉速上限（maxRate）—— 只砍「急甩」那一下。實際開起來車頭角速度的分布是
   *      中位 16°/s、九成 60°/s：一般過彎其實很慢，是最上面那一成在甩。
   *      上限訂在 69°/s 剛好卡在九成之上 —— 九成的彎落後只有 1 度（等於沒限速），
   *      0.4 秒的急甩則從 101 砍到 73°/s。
   *
   *      上限不能訂得比這更低：訂 54°/s 的話連九成的彎都會落後 12 度，
   *      毛毛蟲在一般過彎時就看得出來歪掉。而真正決定「畫面最快轉多快」的是
   *      車本身的轉向速度（Rules.C.TURN），不是這裡 —— 限速砍不掉持續過彎的轉速。
   *
   * 限速一定要配 lagMax／lagBoost：髮夾彎一路打死方向的話，鏡頭會愈落愈後面
   * 而且永遠追不回來。落後超過 lagMax 就把上限放寬，落後才會停在一個定值
   * （看起來就像在甩尾，不像鏡頭壞掉）。
   */
  const HEAD_CAM = {
    tau: 0.05,
    lead: 0.055,
    maxRate: 1.20,     /* 每秒最多轉幾弧度（約 69 度／秒），只砍急甩的那一下 */
    lagMax: 0.35,      /* 落後超過這麼多弧度（20 度）才放寬上限 */
    lagBoost: 5.0      /* 超過之後每多一弧度，上限放寬幾倍 */
  };

  /**
   * @param {number} h 目前的鏡頭角
   * @param {number} angle 車頭角
   * @param {number} turnVel 車頭的角速度（弧度／秒）
   * @param {number} dt 這一幀幾秒
   * @param {number} [maxRate] 轉速上限（弧度／秒），不給就用 HEAD_CAM.maxRate
   * @returns {number} 這一幀的鏡頭角
   */
  function headCamYaw(h, angle, turnVel, dt, maxRate) {
    const step = dt > 0 ? dt : 1 / 60;
    const target = angle + (turnVel || 0) * HEAD_CAM.lead;
    const dh = wrapPi(target - h);
    let move = dh * (1 - Math.exp(-step / HEAD_CAM.tau));

    const lag = Math.abs(dh);
    let cap = (maxRate > 0 ? maxRate : HEAD_CAM.maxRate) * step;
    if (lag > HEAD_CAM.lagMax) cap *= 1 + (lag - HEAD_CAM.lagMax) * HEAD_CAM.lagBoost;
    if (move > cap) move = cap; else if (move < -cap) move = -cap;

    return wrapPi(h + move);
  }

  function wrapPi(a) {
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
  }

  /**
   * 把鏡頭角往目標推進一幀。
   * @param {{h:number, rate:number}} cam 目前的鏡頭角與轉速（會被就地更新）
   * @param {number} target 目標角度
   * @param {number} dt 這一幀幾秒
   * @param {number} [follow] 跟隨強度（預設 CAM_YAW.follow）
   */
  function stepCamYaw(cam, target, dt, follow) {
    const dh = wrapPi(target - cam.h);
    const step = dt > 0 ? dt : 1 / 60;
    let want = Math.abs(dh) < CAM_YAW.dead ? 0 : dh * (follow || CAM_YAW.follow) / Math.max(step, 1 / 240);
    const lag = Math.abs(dh);
    let cap = CAM_YAW.maxRate;
    if (lag > CAM_YAW.lagMax) cap *= 1 + (lag - CAM_YAW.lagMax) * CAM_YAW.lagBoost;
    if (want > cap) want = cap; else if (want < -cap) want = -cap;

    const rate = cam.rate || 0;
    cam.rate = rate + (want - rate) * (want * rate < 0 ? CAM_YAW.rateFlip : CAM_YAW.rateLerp);
    if (cam.rate * dh < 0) cam.rate = 0;
    let move = cam.rate * step;
    if (Math.abs(move) > Math.abs(dh)) { move = dh; cam.rate = 0; }
    cam.h = wrapPi(cam.h + move);
    return cam;
  }

  /* ---------- 轉動時的邊緣壓暗 ----------
   *
   * 會暈的機制是「周邊視覺的流動」：畫面一轉，眼角的東西刷過去的速度最快，
   * 而周邊視覺正是負責判斷「我在動」的那一塊。壓暗邊緣把那份訊號砍掉，
   * 中間看得清楚的區域完全不動 —— 這是模擬器與 VR 的標準做法。
   *
   * 相對於調手感的好處是它「不用付代價」：不動轉向、不動速度、
   * 鏡頭也完全不用落後，鏡頭還是死鎖在車頭上。
   * 只在真的轉得快的時候才出現，直線上完全看不到。
   */
  const SWAY = {
    from: 0.55,     /* 轉速超過這個（弧度／秒，約 32 度／秒）才開始壓暗 */
    to: 1.90,       /* 到這個轉速壓到最重（約 109 度／秒，接近滿舵） */
    max: 0.55       /* 最重的時候邊緣的不透明度 */
  };

  /**
   * @param {number} rate 鏡頭現在的轉速（弧度／秒，取絕對值）
   */
  function drawSwayShade(ctx, P, rate) {
    const k = Math.max(0, Math.min(1, (Math.abs(rate) - SWAY.from) / (SWAY.to - SWAY.from)));
    if (k <= 0.004) return;
    const v = P.view;
    /* 中間留一大塊完全不動：內圈半徑跟著畫面短邊走，所以直橫向都一樣 */
    const short = Math.min(v.w, v.h);
    const g = ctx.createRadialGradient(
      v.w * 0.5, v.h * 0.52, short * 0.40,
      v.w * 0.5, v.h * 0.52, short * 0.92);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.55, 'rgba(0,0,0,' + (0.30 * k).toFixed(3) + ')');
    g.addColorStop(1, 'rgba(0,0,0,' + (SWAY.max * k).toFixed(3) + ')');
    ctx.save();
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, v.w, v.h);
    ctx.restore();
  }

  /**
   * 進隧道壓暗、出隧道回亮。
   *
   * 畫在所有東西的最上面，是一層四角壓得比中間重的暗角 ——
   * 平均壓暗整個畫面只會讓人覺得「螢幕變暗了」，
   * 四角重、中間輕才讀得出「我在一個管子裡，光從前面來」。
   *
   * @param {number} k 0＝完全在洞外，1＝完全在洞裡（呼叫端自己做平滑）
   */
  function drawTunnelShade(ctx, P, theme, k) {
    if (k <= 0.004) return;
    const v = P.view;
    const SC = surfaceColors(theme);
    ctx.save();
    /* 底色：整體壓一層，量不大 */
    ctx.globalAlpha = 0.34 * k;
    ctx.fillStyle = SC.roof;
    ctx.fillRect(0, 0, v.w, v.h);
    /* 暗角：中間留亮，越往外越重 */
    const g = ctx.createRadialGradient(
      v.w * 0.5, P.horizon + v.h * 0.06, Math.min(v.w, v.h) * 0.12,
      v.w * 0.5, P.horizon + v.h * 0.06, Math.max(v.w, v.h) * 0.78);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.55, 'rgba(0,0,0,0.28)');
    g.addColorStop(1, 'rgba(0,0,0,0.72)');
    ctx.globalAlpha = k;
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, v.w, v.h);
    ctx.restore();
  }

  /** 遠處霧化：地平線附近淡進天空色，遠方才不會是一堆銳利的小三角 */
  function drawFog(ctx, P, theme) {
    const v = P.view, hz = P.horizon;
    const g = ctx.createLinearGradient(0, hz - 2, 0, hz + v.h * 0.15);
    g.addColorStop(0, theme.skyLow);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = g;
    ctx.fillRect(0, hz - 2, v.w, v.h * 0.15 + 2);
    ctx.restore();
  }

  /* ================================================================
   *  三、賽道
   *  一段一段畫成四邊形：草地帶 → 緣石 → 路面。
   *  相鄰段用兩種色階交替，跑起來才看得出速度與距離。
   * ================================================================ */

  /* ---------- 新地形的配色 ----------
   *
   * 水坑、上下坡、隧道的顏色不寫進 themes/tracks-art.js，而是從該主題原本的
   * 路面／岩石／天空色推出來。十二套主題乘五個顏色是六十個值，手挑一輪
   * 不但煩，而且熔岩、雪地、夜晚那幾套的色調差很多，挑不好就會有主題「破色」。
   * 推導出來的顏色一定跟該主題同調，之後新增主題也自動就有。
   * 真的要指定就在主題裡寫同名的鍵，這裡會優先用它。
   */
  function hexToRgb(h) {
    return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  }
  function toHex(c) {
    return '#' + c.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
  }
  /** a 與 b 依 t 混合（t=0 全 a，t=1 全 b） */
  function mix(a, b, t) {
    const x = hexToRgb(a), y = hexToRgb(b);
    return toHex([0, 1, 2].map(i => x[i] + (y[i] - x[i]) * t));
  }
  /** 變亮（t>0）或變暗（t<0） */
  function shade(c, t) {
    return t >= 0 ? mix(c, '#ffffff', t) : mix(c, '#000000', -t);
  }

  const surfCache = new WeakMap();
  function surfaceColors(theme) {
    let c = surfCache.get(theme);
    if (c) return c;
    /* 缺鍵就退回路面色。主題資料少一個鍵不該讓整個賽道畫不出來，
     * 而且測試會餵只有 road／roadEdge 的假主題進來。 */
    const road = theme.road || '#c8a070';
    const pick = (k, fallback) => (typeof theme[k] === 'string' ? theme[k] : fallback);
    const sky2 = pick('sky2', '#9fd8f5');
    const boost = pick('boost', '#bfefff');
    const rock = pick('rock', road);
    const rockDark = pick('rockDark', shade(road, -0.3));
    const roadEdge = pick('roadEdge', shade(road, 0.3));
    c = {
      /* 水：往主題的天空藍靠，但壓暗一點，才看得出是「積水」不是「亮片」 */
      water: theme.water || mix(shade(road, -0.35), sky2, 0.72),
      waterLip: theme.waterLip || mix(boost, '#ffffff', 0.35),
      /* 上坡壓暗、下坡提亮：坡面迎光背光的直覺，不用真的做高度就讀得出來 */
      slopeUp: theme.slopeUp || shade(road, -0.22),
      slopeDown: theme.slopeDown || shade(road, 0.20),
      /* 箭頭用路面的對比色，才不會糊在路面裡 */
      slopeUpMark: theme.slopeUpMark || shade(road, -0.48),
      slopeDownMark: theme.slopeDownMark || shade(roadEdge, 0.35),
      /* 隧道：牆用岩石色壓暗，頂再更暗 */
      wall: theme.wall || shade(rock, -0.30),
      wallDark: theme.wallDark || shade(rockDark, -0.45),
      roof: theme.roof || shade(rockDark, -0.66)
    };
    surfCache.set(theme, c);
    return c;
  }

  /** 賽道在某節點彎得多兇（決定要不要畫紅白緣石） */
  function curveAt(nodes, i, span, open) {
    const n = nodes.length;
    const wrap = j => (open ? Math.max(0, Math.min(n - 1, j)) : ((j % n) + n) % n);
    const a = nodes[wrap(i - span)], b = nodes[wrap(i + span)];
    return Math.abs(Math.atan2(a.tx * b.ty - a.ty * b.tx, a.tx * b.tx + a.ty * b.ty));
  }

  /* 隧道的尺寸（世界單位）。牆站在路肩外一點，頂蓋住整個斷面。
   * 淨高抓得比鏡頭高度（CAM_VIEWS.height 約 62）高一截，
   * 不然鏡頭會穿過天花板，畫面上半就破了。 */
  const TUNNEL_H = 96;
  const TUNNEL_LIP = 14;

  function makeSegDraw(P, a, b, c, theme, band, corner, feat) {
    feat = feat || { slope: 0, tunnel: 0 };
    const SC = surfaceColors(theme);
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    /* 下一段的法線：兩段之間在節點 b 會夾出一個楔形缺口，等一下要補起來。
     * 以前是補一個整圓，圓會凸出路面兩側，路邊就變成一顆一顆的扇貝邊
     *（玩家看到的「賽道線鋸齒狀」）。只補真正缺的那個扇形就不會了。 */
    let mx = nx, my = ny, sweep = 0;
    if (c) {
      const ex = c.x - b.x, ey = c.y - b.y;
      const el = Math.hypot(ex, ey);
      if (el > 1e-6) {
        mx = -ey / el; my = ex / el;
        sweep = Math.atan2(nx * my - ny * mx, nx * mx + ny * my);
      }
    }

    function polygon(ctx, corners, fill) {
      const clipped = clipNear(P, corners);
      if (clipped.length < 3) return;
      const points = clipped.map(p => P.pt(p.x, p.y, 0));
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
      ctx.closePath(); ctx.fill();
    }

    function quad(ctx, extra, fill) {
      const wa = a.w + extra, wb = b.w + extra;
      polygon(ctx, [
        { x: a.x + nx * wa, y: a.y + ny * wa },
        { x: b.x + nx * wb, y: b.y + ny * wb },
        { x: b.x - nx * wb, y: b.y - ny * wb },
        { x: a.x - nx * wa, y: a.y - ny * wa }
      ], fill);
    }

    function join(ctx, extra, fill) {
      /* 只補外側的扇形：從這一段的法線掃到下一段的法線，半徑就是路寬。
       * 左彎的外側是右邊，右彎的外側是左邊；內側本來就被兩段蓋住，不用也不能補。 */
      if (Math.abs(sweep) < 2e-3) return;
      const r = b.w + extra;
      const side = sweep > 0 ? -1 : 1;
      const a0 = Math.atan2(ny * side, nx * side);
      const steps = Math.max(2, Math.ceil(Math.abs(sweep) / 0.14));
      const corners = [{ x: b.x, y: b.y }];
      for (let i = 0; i <= steps; i++) {
        const ang = a0 + sweep * (i / steps);
        corners.push({ x: b.x + Math.cos(ang) * r, y: b.y + Math.sin(ang) * r });
      }
      polygon(ctx, corners, fill);
    }

    function edge(ctx) {
      const color = corner ? (band ? '#E2564E' : '#FDF6EA') : theme.roadEdge;
      quad(ctx, RUMBLE, color);
      join(ctx, RUMBLE, color);
    }

    function road(ctx) {
      /* 坡直接換路面色 —— 這是玩家唯一會注意到的提示，不能只靠箭頭，
       * 箭頭在遠處會小到看不見。 */
      const fill = feat.slope > 0 ? SC.slopeUp : (feat.slope < 0 ? SC.slopeDown : theme.road);
      quad(ctx, 0, fill);
      join(ctx, 0, fill);
    }

    /**
     * 坡上的人字箭頭：上坡朝前（要爬上去），下坡也朝前（衝下去），
     * 用顏色跟開口方向區分 —— 上坡是暗色的「∧」，下坡是亮色的「∨」。
     */
    function chevron(ctx) {
      if (!feat.slope) return;
      const fa = P.fwd(a.x, a.y);
      if (fa < NEAR || fa > 900) return;              /* 太遠畫了也看不見，純浪費 */
      const up = feat.slope > 0;
      const w = a.w * 0.34;
      const tip = up ? 1 : -1;                        /* ∧ 或 ∨ */
      const pts = [
        { x: a.x - nx * w - dx * 0.30 * tip, y: a.y - ny * w - dy * 0.30 * tip },
        { x: a.x + dx * 0.34 * tip, y: a.y + dy * 0.34 * tip },
        { x: a.x + nx * w - dx * 0.30 * tip, y: a.y + ny * w - dy * 0.30 * tip }
      ];
      const clipped = clipNear(P, pts);
      if (clipped.length < 3) return;
      const sp = clipped.map(p => P.pt(p.x, p.y, 0));
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = up ? SC.slopeUpMark : SC.slopeDownMark;
      ctx.lineWidth = Math.max(1.5, 7 * sp[1].s);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(sp[0].x, sp[0].y);
      for (let i = 1; i < sp.length; i++) ctx.lineTo(sp[i].x, sp[i].y);
      ctx.stroke();
      ctx.restore();
    }

    /**
     * 隧道：兩側的牆與上面的頂。
     *
     * 投影本來就吃得下高度（P.pt 的第三個參數），所以牆就是「把路肩那條線
     * 從 z=0 拉到 z=TUNNEL_H」的四邊形，頂是兩道牆頂端之間的蓋子。
     * 畫的順序是牆→頂：頂會蓋住牆的上緣，接縫才不會露出草地的顏色。
     */
    function tunnel(ctx) {
      if (!feat.tunnel) return;
      const wa = a.w + TUNNEL_LIP, wb = b.w + TUNNEL_LIP;
      const corners = [
        [{ x: a.x + nx * wa, y: a.y + ny * wa }, { x: b.x + nx * wb, y: b.y + ny * wb }],
        [{ x: a.x - nx * wa, y: a.y - ny * wa }, { x: b.x - nx * wb, y: b.y - ny * wb }]
      ];
      /* 側牆：左右兩片，右邊那片壓暗一點，看起來才有立體感 */
      for (let k = 0; k < 2; k++) {
        const lo = clipNear(P, [corners[k][0], corners[k][1]]);
        if (lo.length < 2) continue;
        const p0 = P.pt(lo[0].x, lo[0].y, 0), p1 = P.pt(lo[1].x, lo[1].y, 0);
        const q0 = P.pt(lo[0].x, lo[0].y, TUNNEL_H), q1 = P.pt(lo[1].x, lo[1].y, TUNNEL_H);
        ctx.fillStyle = k === 0 ? SC.wall : SC.wallDark;
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y);
        ctx.lineTo(q1.x, q1.y); ctx.lineTo(q0.x, q0.y);
        ctx.closePath(); ctx.fill();
      }
      /* 頂：四個角都在 TUNNEL_H 上 */
      const roof = clipNear(P, [corners[0][0], corners[0][1], corners[1][1], corners[1][0]]);
      if (roof.length >= 3) {
        const sp = roof.map(p => P.pt(p.x, p.y, TUNNEL_H));
        ctx.fillStyle = SC.roof;
        ctx.beginPath();
        ctx.moveTo(sp[0].x, sp[0].y);
        for (let i = 1; i < sp.length; i++) ctx.lineTo(sp[i].x, sp[i].y);
        ctx.closePath(); ctx.fill();
      }
    }

    return {
      edge, road, chevron, tunnel,
      draw(ctx) {
        edge(ctx);
        road(ctx);
        chevron(ctx);
        tunnel(ctx);
      }
    };
  }

  /** 以整個路面多邊形裁切近平面，不能只裁中心線。 */
  function clipNear(P, corners) {
    const out = [];
    for (let i = 0; i < corners.length; i++) {
      const a = corners[i], b = corners[(i + 1) % corners.length];
      const fa = P.fwd(a.x, a.y), fb = P.fwd(b.x, b.y);
      if (fa >= NEAR) out.push(a);
      if ((fa < NEAR) !== (fb < NEAR)) {
        const t = (NEAR - fa) / (fb - fa);
        out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      }
    }
    return out;
  }

  /** 收集賽道的地面多邊形。回傳的東西由呼叫端依距離排序後畫。 */
  function trackFaces(P, track, fromNode, theme, out) {
    const nodes = track.nodes, n = nodes.length;
    /* 每段用相鄰節點；跨過急彎會把路面拉成穿越草地的四邊形。 */
    for (let i = -BEHIND_NODES; i < AHEAD_NODES; i++) {
      const wrap = j => (track.open ? Math.max(0, Math.min(n - 1, j)) : ((j % n) + n) % n);
      const ia = wrap(fromNode + i);
      const ib = wrap(fromNode + i + 1);
      if (ia === ib) continue;                /* 衝刺賽道夾到端點之後會重複，跳過 */
      const A = nodes[ia], B = nodes[ib];
      const fa = P.fwd(A.x, A.y), fb = P.fwd(B.x, B.y);
      if (fa + A.w + RUMBLE < NEAR && fb + B.w + RUMBLE < NEAR) continue;
      if (fa - A.w - RUMBLE > FAR && fb - B.w - RUMBLE > FAR) continue;

      /* 視錐裁切：賽道是封閉迴圈，往前數一百多個節點之後會繞回鏡頭旁邊，
       * 那些段的 f 很小、橫向偏移卻是好幾千，畫出來就是一片橫跨畫面的破面。
       * 兩端都落在視野外（橫向／前方 > 1.9，約 62 度）就整段跳過。 */
      const ra = -(A.x - P.cam.x) * P.sin + (A.y - P.cam.y) * P.cos;
      const rb = -(B.x - P.cam.x) * P.sin + (B.y - P.cam.y) * P.cos;
      const wa2 = A.w + RUMBLE, wb2 = B.w + RUMBLE;
      const outA = fa < NEAR || Math.abs(ra) / Math.max(fa, 1) > 1.9 + wa2 / Math.max(fa, 1);
      const outB = fb < NEAR || Math.abs(rb) / Math.max(fb, 1) > 1.9 + wb2 / Math.max(fb, 1);
      if (outA && outB) continue;

      const C = nodes[wrap(fromNode + i + 2)];
      /* 坡與隧道都是「一整段路」，所以問的是節點而不是座標 */
      const feat = {
        slope: track.slopeAt ? track.slopeAt[ia] : 0,
        tunnel: track.inTunnel ? track.inTunnel[ia] : 0
      };
      const segment = makeSegDraw(P, A, B, C === B ? null : C, theme, Math.floor(ia / 5) % 2, curveAt(nodes, ia, 5, track.open) > 0.14, feat);
      out.push({
        f: (fa + fb) / 2,
        draw: segment.draw,
        edge: segment.edge,
        road: segment.road,
        chevron: segment.chevron,
        tunnel: segment.tunnel
      });
    }
  }

  /** 貼在地上的圓形裝飾（泥巴、加速帶、黏液）畫成壓扁的橢圓 */
  const BLOB_NEAR = 95;   /* 鏡頭到玩家之間的地面裝飾會被透視撐成整個畫面 */
  const BLOB_FADE = 155;

  function groundBlob(P, x, y, r, drawFn) {
    const c = P.pt(x, y, 0);
    if (c.f < BLOB_NEAR || c.f > FAR) return null;
    const rx = r * c.s;
    /* 透視讓圓在畫面上前後壓扁，用俯角近似：ry / rx 約等於 camZ / f */
    const ry = rx * Math.min(0.9, P.cam.z / c.f);
    /* 淡出：從 BLOB_NEAR 到 BLOB_FADE 逐漸出現，才不會在畫面下緣「啵」一下冒出來 */
    const fade = c.f >= BLOB_FADE ? 1 : (c.f - BLOB_NEAR) / (BLOB_FADE - BLOB_NEAR);
    return {
      f: c.f,
      draw: ctx => {
        if (fade >= 1) { drawFn(ctx, c.x, c.y, rx, ry, c.s); return; }
        ctx.save(); ctx.globalAlpha *= fade;
        drawFn(ctx, c.x, c.y, rx, ry, c.s);
        ctx.restore();
      }
    };
  }

  function trackDecals(P, track, theme, state, out) {
    const SC = surfaceColors(theme);
    /* 水坑：跟泥巴一樣是貼地的橢圓，但畫法刻意做得不一樣 ——
     * 泥巴是「糊掉的一坨」，水是「亮邊 ＋ 會反光的面」。
     * 兩者的懲罰不同（泥巴慢、水打滑），長得像的話玩家分不出來要怕哪一個。 */
    for (const w of track.water || []) {
      const it = groundBlob(P, w.x, w.y, w.r, (ctx, x, y, rx, ry) => {
        const g = ctx.createRadialGradient(x, y - ry * 0.3, rx * 0.1, x, y, rx);
        g.addColorStop(0, SC.waterLip);
        g.addColorStop(0.35, SC.water);
        g.addColorStop(0.88, SC.water);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, TAU); ctx.fill();
        /* 亮邊：水面跟路面的交界，這一圈是「看起來是水」的關鍵 */
        ctx.save();
        ctx.globalAlpha = 0.5;
        ctx.strokeStyle = SC.waterLip;
        ctx.lineWidth = Math.max(1, rx * 0.06);
        ctx.beginPath(); ctx.ellipse(x, y, rx * 0.94, ry * 0.94, 0, 0, TAU); ctx.stroke();
        /* 兩道反光 */
        ctx.globalAlpha = 0.42; ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.ellipse(x - rx * 0.3, y - ry * 0.34, rx * 0.3, ry * 0.16, 0, 0, TAU); ctx.fill();
        ctx.globalAlpha = 0.26;
        ctx.beginPath(); ctx.ellipse(x + rx * 0.26, y + ry * 0.18, rx * 0.2, ry * 0.11, 0, 0, TAU); ctx.fill();
        ctx.restore();
      });
      if (it) out.push(it);
    }
    for (const m of track.mud) {
      const it = groundBlob(P, m.x, m.y, m.r, (ctx, x, y, rx, ry) => {
        const g = ctx.createRadialGradient(x, y - ry * 0.2, rx * 0.1, x, y, rx);
        g.addColorStop(0, theme.mud);
        g.addColorStop(0.72, theme.mud);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, TAU); ctx.fill();
        ctx.save();
        ctx.globalAlpha = 0.25; ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.ellipse(x - rx * 0.24, y - ry * 0.3, rx * 0.26, ry * 0.2, 0, 0, TAU); ctx.fill();
        ctx.restore();
      });
      if (it) out.push(it);
    }
    for (const p of track.boosts) {
      const it = groundBlob(P, p.x, p.y, p.r, (ctx, x, y, rx, ry) => {
        const g = ctx.createRadialGradient(x, y, rx * 0.08, x, y, rx);
        g.addColorStop(0, 'rgba(255,255,255,.95)');
        g.addColorStop(0.42, theme.boost);
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, TAU); ctx.fill();
        ctx.save();
        ctx.fillStyle = '#fff';
        for (let k = 0; k < 3; k++) {
          ctx.globalAlpha = 0.35 + k * 0.2;
          const oy = y + (k - 1) * ry * 0.52;
          ctx.beginPath();
          ctx.moveTo(x - rx * 0.34, oy + ry * 0.2);
          ctx.lineTo(x, oy - ry * 0.28);
          ctx.lineTo(x + rx * 0.34, oy + ry * 0.2);
          ctx.lineTo(x, oy);
          ctx.closePath(); ctx.fill();
        }
        ctx.restore();
      });
      if (it) out.push(it);
    }
    for (const g0 of state.goo) {
      const it = groundBlob(P, g0.x, g0.y, 24, (ctx, x, y, rx, ry) => {
        const gr = ctx.createRadialGradient(x, y, rx * 0.1, x, y, rx);
        gr.addColorStop(0, 'rgba(199,155,232,.95)');
        gr.addColorStop(1, 'rgba(155,105,200,.12)');
        ctx.fillStyle = gr;
        ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, TAU); ctx.fill();
      });
      if (it) out.push(it);
    }

    /* 終點線：黑白格，橫跨賽道。
     * 環狀賽道的終點就是起點；衝刺賽道的終點在最後一個節點。 */
    const finishNode = track.open ? track.nodes.length - 2 : (track.startNode || 0);
    const n0 = track.nodes[finishNode];
    const f0 = P.fwd(n0.x, n0.y);
    if (f0 > NEAR && f0 < FAR) {
      out.push({
        f: f0,
        draw: ctx => {
          /* 格子大一點、三排，遠遠就看得出來那是終點線 */
          const CELLS = 8, ROWS = 3, ROW_H = 17;
          for (let i = 0; i < CELLS; i++) {
            for (let j = 0; j < ROWS; j++) {
              const o1 = (i / CELLS * 2 - 1) * n0.w, o2 = ((i + 1) / CELLS * 2 - 1) * n0.w;
              const t1 = (j - ROWS / 2) * ROW_H, t2 = (j - ROWS / 2 + 1) * ROW_H;
              const q = [
                P.pt(n0.x + n0.nx * o1 + n0.tx * t1, n0.y + n0.ny * o1 + n0.ty * t1, 0),
                P.pt(n0.x + n0.nx * o2 + n0.tx * t1, n0.y + n0.ny * o2 + n0.ty * t1, 0),
                P.pt(n0.x + n0.nx * o2 + n0.tx * t2, n0.y + n0.ny * o2 + n0.ty * t2, 0),
                P.pt(n0.x + n0.nx * o1 + n0.tx * t2, n0.y + n0.ny * o1 + n0.ty * t2, 0)
              ];
              ctx.fillStyle = ((i + j) % 2) ? '#2C2C2C' : '#FFFFFF';
              ctx.beginPath();
              ctx.moveTo(q[0].x, q[0].y);
              for (let m = 1; m < 4; m++) ctx.lineTo(q[m].x, q[m].y);
              ctx.closePath(); ctx.fill();
            }
          }
        }
      });
    }
  }

  /* ================================================================
   *  四、場景物件：路邊的樹、蘑菇、花、石頭
   * ================================================================ */

  /** 哪些場景物件是「高的」，要離路邊遠一點 */
  const TALL = { tree: 1, candycane: 1, lolly: 1, mushroom: 1, glowbud: 1, building: 1, lamp: 1 };

  const PROPS = {
    garden: ['tree', 'bush', 'flower', 'flower', 'bush'],
    veggie: ['bush', 'carrot', 'flower', 'bush', 'tree'],
    branch: ['tree', 'tree', 'bush', 'acorn'],
    pond: ['reed', 'bush', 'reed', 'flower', 'tree'],
    candy: ['candycane', 'lolly', 'bush', 'lolly'],
    shroom: ['mushroom', 'mushroom', 'glowbud', 'mushroom'],
    beach: ['reed', 'bush', 'reed', 'tree', 'reed'],
    canyon: ['bush', 'acorn', 'bush', 'tree'],
    snow: ['tree', 'bush', 'tree', 'bush'],
    bloom: ['flower', 'flower', 'bush', 'flower', 'tree'],
    volcano: ['bush', 'acorn', 'bush', 'tree'],
    starry: ['glowbud', 'bush', 'flower', 'glowbud', 'tree'],
    /* 城市：大樓為主，夾一點路燈與三角錐當街景 */
    city: ['building', 'building', 'lamp', 'building', 'cone', 'bush'],
    cityNight: ['building', 'building', 'lamp', 'building', 'lamp', 'cone'],
    highway: ['lamp', 'building', 'lamp', 'cone', 'building']
  };

  /** 開局沿賽道兩側撒一次，之後每一幀只是投影它們 */
  function buildScenery(track, rng) {
    const kinds = PROPS[track.theme] || PROPS.garden;
    const Tr = root.Tracks;
    const out = [];
    for (let i = 0; i < track.nodes.length; i += 4) {
      const nd = track.nodes[i];
      for (const side of [-1, 1]) {
        if (!rng.chance(0.6)) continue;
        const kind = kinds[Math.floor(rng.next() * kinds.length)];
        /* 高的東西要離路邊遠一點，不然近距離會整棵擋住前面的賽道；
         * 矮的（花、草叢、蘆葦）可以貼著路邊長，路肩才不會空空的。 */
        const tall = TALL[kind];
        const off = (nd.w + (tall ? 165 : 58) + rng.range(0, tall ? 200 : 120)) * side;
        const x = nd.x + nd.nx * off, y = nd.y + nd.ny * off;
        /* 只長在草地上，不要長到別段賽道中間 */
        if (Tr && Tr.surfaceAt(track, x, y) !== Tr.SURFACE.GRASS) continue;
        let onRock = false;
        for (const rk of track.rocks) if (Math.hypot(rk.x - x, rk.y - y) < rk.r + 24) onRock = true;
        if (onRock) continue;
        out.push({ x: x, y: y, kind: kind, h: rng.range(0.75, 1.35), seed: rng.next() });
      }
    }
    /* 石頭同時是障礙物，尺寸來自賽道資料 */
    for (const rk of track.rocks) out.push({ x: rk.x, y: rk.y, kind: 'rock', r: rk.r, h: 1, seed: 0.5 });
    /* 交通標誌：位置是賽道算好的（路邊固定距離），不用也不能隨機擺 */
    for (const sg of track.signs || []) {
      out.push({ x: sg.x, y: sg.y, kind: 'sign', sign: sg.kind, h: 1, seed: 0.5 });
    }
    return out;
  }

  function drawProp(ctx, prop, bx, by, s, theme, t) {
    const k = prop.kind;
    const H = u => u * prop.h * s;
    const W = u => u * prop.h * s;

    function shadow(rx, ry) {
      ctx.save();
      ctx.globalAlpha = 0.2;
      ctx.fillStyle = '#000';
      ctx.beginPath(); ctx.ellipse(bx + rx * 0.22, by, rx, ry, 0, 0, TAU); ctx.fill();
      ctx.restore();
    }

    if (k === 'rock') {
      const r = prop.r * s;
      shadow(r * 1.04, r * 0.32);
      /* 低矮的土丘，不是球。
       * 賽道裡那顆半徑一百多的中央石頭如果照球體畫，近看就是一顆擋住半個畫面的巨球；
       * 壓扁成土丘之後它讀起來是「賽道中間的草丘」，也不會擋住前方。 */
      const flat = prop.r > 100 ? 0.28 : 0.46;
      const cy = by - r * flat * 0.75;
      const big = prop.r > 100;
      if (r > 14) {
        const g = ctx.createRadialGradient(bx - r * 0.34, cy - r * flat * 0.8, r * 0.06, bx, cy, r * 1.1);
        g.addColorStop(0, big ? theme.grassAlt : theme.rock);
        g.addColorStop(0.55, big ? theme.hill : theme.rock);
        g.addColorStop(1, big ? theme.hillDark : theme.rockDark);
        ctx.fillStyle = g;
      } else ctx.fillStyle = big ? theme.hill : theme.rock;
      ctx.beginPath(); ctx.ellipse(bx, cy, r, r * flat, 0, Math.PI, TAU); ctx.fill();
      ctx.beginPath(); ctx.ellipse(bx, cy, r, r * flat * 0.42, 0, 0, TAU); ctx.fill();
      ctx.strokeStyle = big ? theme.hillDark : theme.rockDark;
      ctx.lineWidth = Math.max(1, r * 0.025);
      ctx.beginPath(); ctx.ellipse(bx, cy, r, r * flat, 0, Math.PI, TAU); ctx.stroke();
      /* 上面長的草（大土丘再加幾朵花） */
      for (let i = 0; i < (big ? 7 : 3); i++) {
        const a = (prop.seed + i * 0.37) * TAU;
        const px = bx + Math.cos(a) * r * 0.55, py = cy - r * flat * 0.55 + Math.sin(a) * r * flat * 0.4;
        ctx.fillStyle = big ? theme.hillDark : theme.grassDark;
        ctx.beginPath(); ctx.ellipse(px, py, r * 0.1, r * 0.05, a, 0, TAU); ctx.fill();
        if (big && i % 2 === 0) {
          ctx.fillStyle = ['#FF8FB1', '#FFE066', '#C39BFF'][i % 3];
          ctx.beginPath(); ctx.arc(px, py - r * 0.03, Math.max(1, r * 0.035), 0, TAU); ctx.fill();
        }
      }
      return;
    }

    const detail = prop.h * s * 20 > 16;   /* 螢幕上夠大才畫漸層 */

    if (k === 'tree') {
      const trunkH = H(50), crownR = W(36);
      shadow(crownR * 0.8, crownR * 0.24);
      ctx.strokeStyle = '#8C5C31';
      ctx.lineWidth = Math.max(1.5, W(8));
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.quadraticCurveTo(bx + W(4), by - trunkH * 0.6, bx, by - trunkH);
      ctx.stroke();
      const cy = by - trunkH - crownR * 0.5;
      if (detail) {
        const g = ctx.createRadialGradient(bx - crownR * 0.35, cy - crownR * 0.42, crownR * 0.08, bx, cy, crownR * 1.25);
        g.addColorStop(0, theme.grassAlt);
        g.addColorStop(0.55, theme.hill);
        g.addColorStop(1, theme.hillDark);
        ctx.fillStyle = g;
      } else ctx.fillStyle = theme.hill;
      for (const o of [[-0.52, 0.22, 0.6], [0.52, 0.2, 0.58], [0, -0.32, 0.7], [0, 0.16, 0.78]]) {
        ctx.beginPath(); ctx.arc(bx + crownR * o[0], cy + crownR * o[1], crownR * o[2], 0, TAU); ctx.fill();
      }
      return;
    }

    /* 交通標誌：一根桿子 ＋ 菱形警告牌 ＋ 圖示。
     *
     * 圖示全部用線條畫在一個正規化的 -1..1 方框裡，再乘上牌子的半徑 ——
     * 這樣同一組座標在遠近任何距離都對，不用為每個距離調一次。
     * 牌面永遠正面朝鏡頭（跟其他景物一樣是 billboard）：
     * 真的把牌子轉向的話，斜著看就只剩一條線，那塊牌子就白立了。 */
    if (k === 'sign') {
      const kind = prop.sign || 'left';
      const postH = H(52);
      const r = W(26);                      /* 牌子的半徑（菱形的對角線一半） */
      shadow(W(9), W(3.5));

      /* 桿子 */
      ctx.strokeStyle = '#8A9199';
      ctx.lineWidth = Math.max(1.2, W(4));
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(bx, by - postH);
      ctx.stroke();

      const cy = by - postH - r * 0.92;

      /* 菱形牌面：黃底黑框，看板的通用語言 */
      ctx.beginPath();
      ctx.moveTo(bx, cy - r);
      ctx.lineTo(bx + r, cy);
      ctx.lineTo(bx, cy + r);
      ctx.lineTo(bx - r, cy);
      ctx.closePath();
      ctx.fillStyle = '#F7C93E';
      ctx.fill();
      ctx.strokeStyle = '#2B2B2B';
      ctx.lineWidth = Math.max(1, r * 0.13);
      ctx.stroke();

      if (r < 7) return;                    /* 太遠就只剩一塊黃菱形，圖示畫了也看不到 */

      /* 圖示：座標是 -1..1，乘 r * 0.52 之後畫 */
      const u = r * 0.52;
      const X = a => bx + a * u, Y = a => cy + a * u;
      ctx.strokeStyle = '#2B2B2B';
      ctx.fillStyle = '#2B2B2B';
      ctx.lineWidth = Math.max(1, r * 0.15);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';

      function poly(pts) {
        ctx.beginPath();
        ctx.moveTo(X(pts[0][0]), Y(pts[0][1]));
        for (let i = 1; i < pts.length; i++) ctx.lineTo(X(pts[i][0]), Y(pts[i][1]));
        ctx.stroke();
      }
      /* 箭頭頭：在 (x,y) 朝 dir（單位向量）畫一個實心三角 */
      function head(x, y, dx, dy) {
        const h = 0.46, w2 = 0.32;
        const px = -dy, py = dx;
        ctx.beginPath();
        ctx.moveTo(X(x + dx * h), Y(y + dy * h));
        ctx.lineTo(X(x + px * w2), Y(y + py * w2));
        ctx.lineTo(X(x - px * w2), Y(y - py * w2));
        ctx.closePath();
        ctx.fill();
      }

      if (kind === 'left' || kind === 'right') {
        const m = kind === 'left' ? -1 : 1;
        /* 從底部往上，然後折向左／右 */
        poly([[0, 1], [0, 0.1], [m * 0.62, -0.5]]);
        head(m * 0.62, -0.5, m * 0.78, -0.62);
      } else if (kind === 'sturn') {
        /* S 形：下面往一邊、上面往另一邊 */
        ctx.beginPath();
        ctx.moveTo(X(-0.1), Y(1));
        ctx.bezierCurveTo(X(-0.1), Y(0.35), X(0.75), Y(0.2), X(0.75), Y(-0.25));
        ctx.bezierCurveTo(X(0.75), Y(-0.6), X(-0.3), Y(-0.55), X(-0.3), Y(-0.95));
        ctx.stroke();
        head(-0.3, -0.95, 0, -1);
      } else if (kind === 'tunnel') {
        /* 拱門：半圓 ＋ 兩腳 ＋ 地面 */
        ctx.beginPath();
        ctx.arc(X(0), Y(0.1), u * 0.78, Math.PI, 0);
        ctx.stroke();
        poly([[-0.78, 0.1], [-0.78, 0.92]]);
        poly([[0.78, 0.1], [0.78, 0.92]]);
        poly([[-1, 0.92], [1, 0.92]]);
      } else if (kind === 'up' || kind === 'down') {
        /* 坡：一個斜面三角形，上坡往右上、下坡往右下 */
        const up = kind === 'up';
        ctx.beginPath();
        ctx.moveTo(X(-0.9), Y(0.7));
        ctx.lineTo(X(0.9), Y(0.7));
        ctx.lineTo(X(up ? 0.9 : -0.9), Y(-0.75));
        ctx.closePath();
        ctx.fill();
      } else if (kind === 'water') {
        /* 水：三條波浪 */
        for (let i = 0; i < 3; i++) {
          const y0 = -0.5 + i * 0.55;
          ctx.beginPath();
          ctx.moveTo(X(-0.85), Y(y0));
          ctx.bezierCurveTo(X(-0.4), Y(y0 - 0.34), X(-0.05), Y(y0 + 0.3), X(0.28), Y(y0));
          ctx.bezierCurveTo(X(0.5), Y(y0 - 0.2), X(0.7), Y(y0 + 0.16), X(0.9), Y(y0 - 0.04));
          ctx.stroke();
        }
      } else {
        /* 不認得的種類就畫一個驚嘆號，至少玩家知道「前面有東西」 */
        poly([[0, -0.85], [0, 0.35]]);
        ctx.beginPath();
        ctx.arc(X(0), Y(0.82), Math.max(1, u * 0.17), 0, TAU);
        ctx.fill();
      }
      return;
    }

    /* 大樓：一個立方體 ＋ 窗戶格子。城市賽道的天際線就靠這個。
     * 用 prop.seed 決定高矮胖瘦與窗戶亮不亮，所以同一種 kind 撒出去
     * 不會是一排一模一樣的積木。 */
    if (k === 'building') {
      const sd = prop.seed || 0.5;
      const w = W(30 + sd * 26);
      const h = H(120 + sd * 150);
      shadow(w * 1.05, w * 0.3);
      const left = bx - w / 2;
      /* 正面與側面：側面壓暗，才有體積感 */
      const face = theme.rock, side = theme.rockDark;
      const dep = w * 0.26;
      ctx.fillStyle = side;
      ctx.beginPath();
      ctx.moveTo(left + w, by);
      ctx.lineTo(left + w + dep, by - h * 0.06);
      ctx.lineTo(left + w + dep, by - h - h * 0.06);
      ctx.lineTo(left + w, by - h);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = face;
      ctx.fillRect(left, by - h, w, h);
      /* 頂樓收邊 */
      ctx.fillStyle = side;
      ctx.fillRect(left, by - h, w, Math.max(1, h * 0.03));

      if (detail) {
        /* 窗戶：夜晚的主題亮燈，白天是暗色的玻璃 */
        const lit = theme.night;
        const cols = Math.max(2, Math.round(w / Math.max(3, W(13))));
        const rows = Math.max(3, Math.round(h / Math.max(4, H(24))));
        const gw = w / cols, gh = h / rows;
        for (let r0 = 0; r0 < rows; r0++) {
          for (let c0 = 0; c0 < cols; c0++) {
            /* 固定的偽隨機：同一棟樓每一幀亮的窗戶都一樣，不會閃爍 */
            const q = ((r0 * 7 + c0 * 13 + Math.floor(sd * 100)) % 10) / 10;
            if (lit && q > 0.55) ctx.fillStyle = theme.sun;
            else if (!lit && q > 0.7) ctx.fillStyle = theme.skyLow;
            else ctx.fillStyle = theme.rockDark;
            ctx.globalAlpha = lit && q > 0.55 ? 0.85 : 0.5;
            ctx.fillRect(left + c0 * gw + gw * 0.22, by - h + r0 * gh + gh * 0.22,
              gw * 0.56, gh * 0.5);
          }
        }
        ctx.globalAlpha = 1;
      }
      return;
    }

    /* 路燈：一根桿子加一個燈頭。夜晚主題會發光。 */
    if (k === 'lamp') {
      const h = H(84), armW = W(16);
      shadow(W(8), W(3));
      ctx.strokeStyle = theme.rockDark;
      ctx.lineWidth = Math.max(1.2, W(4.5));
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(bx, by - h);
      ctx.quadraticCurveTo(bx, by - h - armW * 0.7, bx + armW, by - h - armW * 0.55);
      ctx.stroke();
      ctx.fillStyle = theme.night ? theme.sun : theme.roadEdge;
      ctx.beginPath();
      ctx.ellipse(bx + armW, by - h - armW * 0.42, Math.max(1.2, W(7)), Math.max(1, W(4)), 0, 0, TAU);
      ctx.fill();
      if (detail && theme.night) {
        ctx.save();
        ctx.globalAlpha = 0.28;
        const g = ctx.createRadialGradient(bx + armW, by - h - armW * 0.42, 1,
          bx + armW, by - h - armW * 0.42, W(34));
        g.addColorStop(0, theme.sun);
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(bx + armW, by - h - armW * 0.42, W(34), 0, TAU); ctx.fill();
        ctx.restore();
      }
      return;
    }

    /* 三角錐：矮矮的，可以貼著路邊放 */
    if (k === 'cone') {
      const h = H(26), w = W(13);
      shadow(w * 1.1, w * 0.34);
      ctx.fillStyle = '#E8763A';
      ctx.beginPath();
      ctx.moveTo(bx, by - h);
      ctx.lineTo(bx + w, by);
      ctx.lineTo(bx - w, by);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#FDF6EA';
      ctx.fillRect(bx - w * 0.62, by - h * 0.56, w * 1.24, Math.max(1, h * 0.17));
      return;
    }

    if (k === 'bush') {
      const r = W(21);
      shadow(r * 1.1, r * 0.28);
      const cy = by - r * 0.66;
      if (detail) {
        const g = ctx.createRadialGradient(bx - r * 0.35, cy - r * 0.45, r * 0.06, bx, cy, r * 1.3);
        g.addColorStop(0, theme.grassAlt);
        g.addColorStop(0.6, theme.hill);
        g.addColorStop(1, theme.hillDark);
        ctx.fillStyle = g;
      } else ctx.fillStyle = theme.hill;
      for (const o of [[-0.6, 0.24, 0.58], [0.6, 0.24, 0.58], [0, -0.08, 0.82]]) {
        ctx.beginPath(); ctx.arc(bx + r * o[0], cy + r * o[1], r * o[2], 0, TAU); ctx.fill();
      }
      return;
    }

    if (k === 'mushroom' || k === 'glowbud') {
      const stemH = H(26), capR = W(19);
      shadow(capR, capR * 0.28);
      ctx.fillStyle = '#EFE7FA';
      ctx.beginPath();
      ctx.ellipse(bx, by - stemH * 0.5, W(5), stemH * 0.5, 0, 0, TAU);
      ctx.fill();
      const cy = by - stemH;
      const hot = k === 'glowbud' ? '#8BF0E0' : '#C7A6F5';
      if (detail) {
        const g = ctx.createRadialGradient(bx - capR * 0.3, cy - capR * 0.45, capR * 0.08, bx, cy, capR * 1.2);
        g.addColorStop(0, '#FFFFFF');
        g.addColorStop(0.45, hot);
        g.addColorStop(1, '#6B48B5');
        ctx.fillStyle = g;
      } else ctx.fillStyle = hot;
      ctx.beginPath(); ctx.ellipse(bx, cy, capR, capR * 0.7, 0, Math.PI, TAU); ctx.fill();
      ctx.beginPath(); ctx.ellipse(bx, cy, capR, capR * 0.2, 0, 0, TAU); ctx.fill();
      if (k === 'glowbud') {
        ctx.save();
        ctx.globalAlpha = 0.3 + 0.16 * Math.sin(t * 2 + prop.seed * 9);
        const gl = ctx.createRadialGradient(bx, cy, capR * 0.2, bx, cy, capR * 2.6);
        gl.addColorStop(0, 'rgba(139,240,224,.85)');
        gl.addColorStop(1, 'rgba(139,240,224,0)');
        ctx.fillStyle = gl;
        ctx.beginPath(); ctx.arc(bx, cy, capR * 2.6, 0, TAU); ctx.fill();
        ctx.restore();
      }
      return;
    }

    if (k === 'flower') {
      const stemH = H(18), r = W(8);
      ctx.strokeStyle = theme.hillDark;
      ctx.lineWidth = Math.max(1, W(2));
      ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx, by - stemH); ctx.stroke();
      const colors = ['#FF8FB1', '#FFE066', '#C39BFF', '#FFFFFF', '#7FD8F5'];
      ctx.fillStyle = colors[Math.floor(prop.seed * colors.length)];
      const cy = by - stemH;
      for (let i = 0; i < 5; i++) {
        const a = i * TAU / 5 + prop.seed;
        ctx.beginPath();
        ctx.ellipse(bx + Math.cos(a) * r * 0.7, cy + Math.sin(a) * r * 0.7, r * 0.55, r * 0.4, a, 0, TAU);
        ctx.fill();
      }
      ctx.fillStyle = '#FFD54A';
      ctx.beginPath(); ctx.arc(bx, cy, r * 0.4, 0, TAU); ctx.fill();
      return;
    }

    if (k === 'reed') {
      ctx.strokeStyle = theme.hillDark;
      ctx.lineWidth = Math.max(1, W(2.6));
      ctx.lineCap = 'round';
      for (let i = -1; i <= 1; i++) {
        const h = H(28 + i * 5);
        ctx.beginPath();
        ctx.moveTo(bx + W(i * 4), by);
        ctx.quadraticCurveTo(bx + W(i * 9), by - h * 0.6, bx + W(i * 6), by - h);
        ctx.stroke();
      }
      return;
    }

    if (k === 'carrot') {
      const h = H(20);
      ctx.fillStyle = theme.hillDark;
      for (let i = -1; i <= 1; i++) {
        ctx.beginPath();
        ctx.ellipse(bx + W(i * 5), by - h, W(4), W(9), i * 0.4, 0, TAU);
        ctx.fill();
      }
      ctx.fillStyle = '#FF9A3D';
      ctx.beginPath();
      ctx.moveTo(bx - W(7), by - h * 0.5); ctx.lineTo(bx + W(7), by - h * 0.5); ctx.lineTo(bx, by);
      ctx.closePath(); ctx.fill();
      return;
    }

    if (k === 'acorn') {
      const r = W(10);
      shadow(r, r * 0.28);
      ctx.fillStyle = '#E7C39A';
      ctx.beginPath(); ctx.ellipse(bx, by - r, r * 0.8, r, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = '#8A5A2E';
      ctx.beginPath(); ctx.ellipse(bx, by - r * 1.5, r * 0.9, r * 0.45, 0, 0, TAU); ctx.fill();
      return;
    }

    if (k === 'candycane') {
      const h = H(44);
      ctx.lineWidth = Math.max(1.5, W(6));
      ctx.lineCap = 'round';
      const path = () => {
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.lineTo(bx, by - h * 0.7);
        ctx.quadraticCurveTo(bx, by - h, bx + W(13), by - h * 0.86);
      };
      ctx.strokeStyle = '#FFFFFF'; path(); ctx.stroke();
      ctx.save();
      ctx.strokeStyle = '#FF7A9A';
      ctx.setLineDash([Math.max(2, W(6)), Math.max(2, W(7))]);
      path(); ctx.stroke();
      ctx.restore();
      return;
    }

    /* lolly */
    const h = H(32), r = W(14);
    shadow(r * 0.8, r * 0.24);
    ctx.strokeStyle = '#FFF3D8';
    ctx.lineWidth = Math.max(1, W(3.5));
    ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx, by - h); ctx.stroke();
    const cy = by - h - r * 0.5;
    const g = ctx.createRadialGradient(bx - r * 0.3, cy - r * 0.4, r * 0.08, bx, cy, r * 1.2);
    g.addColorStop(0, '#FFFFFF');
    g.addColorStop(0.5, prop.seed > 0.5 ? '#FF9EC4' : '#9BE3E8');
    g.addColorStop(1, prop.seed > 0.5 ? '#D9578F' : '#4FA8B5');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(bx, cy, r, 0, TAU); ctx.fill();
  }

  /** 道具葉：浮在地面上方，底下有影子 */
  /**
   * 道具點：一顆會轉的泡泡，裡面包一片葉子。
   *
   * 原本只畫一片立著的葉子，結果跟路邊的裝飾葉子長得一模一樣，
   * 誰也看不出那是「撞下去會拿到道具」的東西。改成泡泡之後，
   * 地上有光圈、身上有高光、還會慢慢轉，一眼就知道是要去撞的。
   */
  function drawLeaf(ctx, bx, by, s, t, seed, f) {
    const lift = (24 + Math.sin(t * 2.2 + seed) * 3.5) * s;
    const r = 17 * s;
    /* 靠太近就淡出：鏡頭在玩家後面，中間的葉子會被放到超大擋住畫面 */
    const near = Math.max(0, Math.min(1, (f - 55) / 90));
    if (near <= 0.02) return;
    ctx.save();
    ctx.globalAlpha = near;

    /* 地上的光圈：告訴你「這裡有東西」，而且標出撞得到的位置 */
    ctx.save();
    ctx.globalAlpha = near * (0.35 + 0.12 * Math.sin(t * 3 + seed));
    ctx.strokeStyle = '#FFD54A';
    ctx.lineWidth = Math.max(1, r * 0.16);
    ctx.beginPath(); ctx.ellipse(bx, by, r * 0.95, r * 0.38, 0, 0, TAU); ctx.stroke();
    ctx.restore();
    ctx.save();
    ctx.globalAlpha = near * 0.16;
    ctx.fillStyle = '#000';
    ctx.beginPath(); ctx.ellipse(bx, by, r * 0.62, r * 0.25, 0, 0, TAU); ctx.fill();
    ctx.restore();

    const cy = by - lift;
    /* 泡泡裡的葉子：左右擺一點，看得出來它在轉 */
    const spin = Math.sin(t * 1.6 + seed);
    const lw = r * 0.5 * Math.max(0.25, Math.abs(spin));
    ctx.fillStyle = '#8BD44A';
    ctx.beginPath();
    ctx.moveTo(bx, cy - r * 0.62);
    ctx.quadraticCurveTo(bx + lw, cy, bx, cy + r * 0.62);
    ctx.quadraticCurveTo(bx - lw, cy, bx, cy - r * 0.62);
    ctx.fill();
    ctx.strokeStyle = '#3C7A14';
    ctx.lineWidth = Math.max(0.6, r * 0.08);
    ctx.stroke();

    /* 泡泡本體 */
    if (r > 9) {
      const bub = ctx.createRadialGradient(bx - r * 0.35, cy - r * 0.4, r * 0.1, bx, cy, r);
      bub.addColorStop(0, 'rgba(255,255,255,.75)');
      bub.addColorStop(0.55, 'rgba(255,255,255,.14)');
      bub.addColorStop(1, 'rgba(180,230,255,.34)');
      ctx.fillStyle = bub;
      ctx.beginPath(); ctx.arc(bx, cy, r, 0, TAU); ctx.fill();
    }
    ctx.strokeStyle = 'rgba(255,255,255,.9)';
    ctx.lineWidth = Math.max(1, r * 0.09);
    ctx.beginPath(); ctx.arc(bx, cy, r, 0, TAU); ctx.stroke();
    if (r > 7) {
      ctx.fillStyle = 'rgba(255,255,255,.95)';
      ctx.beginPath();
      ctx.ellipse(bx - r * 0.38, cy - r * 0.42, r * 0.22, r * 0.13, -0.6, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  /* ================================================================
   *  五、立體毛毛蟲
   *  每一節都是一顆站在地上的球：投影出地面的位置，球心抬高一個半徑，
   *  再畫貼地陰影 ＋ 徑向漸層 ＋ 花紋 ＋ 小腳。
   * ================================================================ */

  /** 沿軌跡往回取等距的點，當作身體各節的地面位置 */
  function sampleTrail(hist, count, gap) {
    const out = [];
    if (!hist.length) return out;
    let want = gap, acc = 0, i = 0;
    out.push({ x: hist[0].x, y: hist[0].y });
    while (out.length <= count && i < hist.length - 1) {
      const a = hist[i], b = hist[i + 1];
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      if (d < 1e-6) { i++; continue; }
      if (acc + d >= want) {
        const k = (want - acc) / d;
        out.push({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k });
        want += gap;
      } else { acc += d; i++; }
    }
    while (out.length <= count) {
      const last = out[out.length - 1] || { x: hist[0].x, y: hist[0].y };
      out.push({ x: last.x, y: last.y + gap });
    }
    return out;
  }

  function segPattern(ctx, kind, r, color) {
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    if (kind === 'dot') { ctx.beginPath(); ctx.arc(0, 0, r * 0.32, 0, TAU); ctx.fill(); }
    else if (kind === 'stripe') ctx.fillRect(-r * 0.78, -r * 0.14, r * 1.56, r * 0.28);
    else if (kind === 'heart') {
      const s = r * 0.4;
      ctx.beginPath();
      ctx.moveTo(0, s * 0.9);
      ctx.bezierCurveTo(-s * 1.6, -s * 0.3, -s * 0.5, -s * 1.3, 0, -s * 0.45);
      ctx.bezierCurveTo(s * 0.5, -s * 1.3, s * 1.6, -s * 0.3, 0, s * 0.9);
      ctx.fill();
    } else if (kind === 'wave') {
      ctx.lineWidth = r * 0.2; ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-r * 0.7, 0);
      ctx.quadraticCurveTo(-r * 0.32, -r * 0.38, 0, 0);
      ctx.quadraticCurveTo(r * 0.32, r * 0.38, r * 0.7, 0);
      ctx.stroke();
    } else if (kind === 'star') {
      const s = r * 0.46;
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + i * Math.PI / 5;
        const rad = i % 2 ? s * 0.45 : s;
        ctx[i ? 'lineTo' : 'moveTo'](Math.cos(a) * rad, Math.sin(a) * rad);
      }
      ctx.closePath(); ctx.fill();
    } else if (kind === 'check') {
      const s = r * 0.3;
      ctx.fillRect(-s, -s, s, s); ctx.fillRect(0, 0, s, s);
    } else if (kind === 'leaf') {
      const s = r * 0.48;
      ctx.beginPath();
      ctx.moveTo(0, -s); ctx.quadraticCurveTo(s * 0.9, 0, 0, s); ctx.quadraticCurveTo(-s * 0.9, 0, 0, -s);
      ctx.fill();
    } else if (kind === 'tri') {
      const s = r * 0.44;
      ctx.beginPath();
      ctx.moveTo(0, -s); ctx.lineTo(s * 0.9, s * 0.6); ctx.lineTo(-s * 0.9, s * 0.6);
      ctx.closePath(); ctx.fill();
    }
  }

  /**
   * 頭上的臉。追尾視角看得到正面還是背面，取決於牠往哪邊跑：
   * 往前跑（遠離鏡頭）只看得到後腦勺與觸角，轉過來才看得到眼睛。
   */
  function drawFace(ctx, P, ch, cx, cy, rr, o, alpha) {
    if (rr < 3.5) return;
    let rel = (o.angle || 0) - P.cam.a;
    while (rel > Math.PI) rel -= TAU;
    while (rel < -Math.PI) rel += TAU;
    const away = Math.cos(rel);          /* +1 完全背對、-1 完全面向鏡頭 */

    /* 觸角：兩顆白色小圓球，正面背面都看得到。
     * 追尾視角大半時間只看得到後腦勺，這兩顆白球就是「哪一顆是頭」的唯一線索，
     * 所以畫得比球本身還醒目，而且不隨轉向消失。 */
    const antR = Math.max(1, rr * 0.24);
    for (const side of [-1, 1]) {
      const sway = Math.sin((o.t || 0) * 5 + side) * 0.10;
      const tipX = cx + side * rr * (0.48 + sway);
      const tipY = cy - rr * (1.24 + 0.06 * Math.sin((o.t || 0) * 5 + side * 1.7));
      ctx.strokeStyle = ch.bodyDark;
      ctx.lineWidth = Math.max(0.8, rr * 0.13);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(cx + side * rr * 0.22, cy - rr * 0.78);
      ctx.lineTo(tipX, tipY);
      ctx.stroke();
      ctx.fillStyle = '#FFFFFF';
      ctx.beginPath(); ctx.arc(tipX, tipY, antR, 0, TAU); ctx.fill();
      if (antR > 3) {
        ctx.fillStyle = 'rgba(0,0,0,.13)';
        ctx.beginPath(); ctx.arc(tipX + antR * 0.22, tipY + antR * 0.26, antR * 0.62, 0, TAU); ctx.fill();
      }
    }

    if (away > 0.35) {
      /* 背對鏡頭：就是一顆後腦勺 —— 參考畫面裡從後面看也真的只有球加觸角。
       * 硬把眼睛畫出來反而會變成「臉長在後腦」，所以只補一道下緣的暗邊，
       * 讓頭跟後面那節分得開，其餘交給顏色與觸角辨識。 */
      ctx.save();
      ctx.globalAlpha = alpha * 0.30;
      ctx.strokeStyle = ch.bodyDark;
      ctx.lineWidth = Math.max(0.8, rr * 0.14);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(cx, cy + rr * 0.1, rr * 0.66, 0.62, Math.PI - 0.62);
      ctx.stroke();
      ctx.restore();
      return;
    }

    /* 側面到正面：眼睛跟著轉頭左右挪 */
    const shift = -Math.sin(rel) * rr * 0.4;
    const open = Math.min(1, (0.35 - away) / 0.8);
    const eyeR = rr * 0.3;
    ctx.fillStyle = '#fff';
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(cx + shift + side * rr * 0.36, cy - rr * 0.08, eyeR * (0.6 + 0.4 * open), eyeR, 0, 0, TAU);
      ctx.fill();
    }
    ctx.fillStyle = ch.eye;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(cx + shift * 1.2 + side * rr * 0.36, cy - rr * 0.05, eyeR * 0.5, 0, TAU);
      ctx.fill();
    }
    ctx.fillStyle = '#fff';
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(cx + shift * 1.2 + side * rr * 0.36 + eyeR * 0.15, cy - rr * 0.18, Math.max(0.5, eyeR * 0.2), 0, TAU);
      ctx.fill();
    }
    ctx.save();
    ctx.globalAlpha = alpha * 0.5;
    ctx.fillStyle = '#FF8FA8';
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(cx + shift + side * rr * 0.62, cy + rr * 0.3, rr * 0.2, rr * 0.13, 0, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
    ctx.strokeStyle = ch.eye;
    ctx.lineWidth = Math.max(0.7, rr * 0.11);
    ctx.beginPath();
    ctx.arc(cx + shift, cy + rr * 0.18, rr * 0.28, 0.5, Math.PI - 0.5);
    ctx.stroke();
  }

  /**
   * 畫一隻立體毛毛蟲。
   * @param {Array} pts 身體各節的「地面世界座標」（[0] 是頭）
   * @param {object} o  { t, angle, boost（加速中）, tiny, ghost, shield, hop, slow, reduceMotion, isMe }
   */
  function drawWorm3D(ctx, P, ch, pts, o) {
    const scale = o.tiny ? 0.72 : 1;
    const alpha = o.ghost ? 0.35 : 1;
    const t = o.t || 0;
    /* 身體不做左右擺、也不做上下起伏。
     * 追尾視角下那兩個動作看起來就是「毛毛蟲在畫面裡抖」跟「整隻浮在空中」，
     * 全部拿掉之後每一節都是確實站在地上的球，只剩小腳在動。 */
    const freq = 6.5;
    const lift = o.hop ? 26 : 0;
    const air = lift / 26;

    /* 先把每一節投影好，再分層畫。
     * 舊版是「一節算完就整節畫完」，於是每顆球各有一圈深色外框、
     * 各有一塊半透明影子；球互相疊住之後，那些外框與影子就一層一層透出來，
     * 看起來就像毛毛蟲拖著殘影。改成分層之後，外框與影子都只有一份。 */
    const segs = [];
    for (let i = 0; i < pts.length; i++) {
      const isHead = i === 0;
      const R = segRadius(i, scale);
      const g0 = P.pt(pts[i].x, pts[i].y, 0);
      if (g0.f < NEAR * 0.9 || g0.f > FAR) continue;
      const rr = R * g0.s;
      if (rr < 0.7) continue;
      segs.push({ i, isHead, x: g0.x, gy: g0.y, cy: g0.y - (segHeight(i, scale) + lift) * g0.s, rr, f: g0.f });
    }
    if (!segs.length) return;
    /* 由遠到近：遠的先畫，近的蓋上去 */
    segs.sort((a, b) => b.f - a.f);

    ctx.save();
    ctx.globalAlpha = alpha;

    /* 一、貼地陰影：所有節合成同一條路徑，只填一次。
     * 分開填的話重疊處會疊出兩倍濃度，那正是看起來像殘影的一塊。 */
    ctx.save();
    ctx.globalAlpha = alpha * 0.34 * Math.max(0.35, 1 - air * 0.8);
    ctx.fillStyle = '#000';
    ctx.beginPath();
    for (const g of segs) {
      ctx.ellipse(g.x, g.gy, g.rr * Math.max(0.75, 1.02 - air * 0.3), g.rr * 0.30, 0, 0, TAU);
    }
    ctx.fill();
    ctx.restore();

    /* 二、小腳：畫在身體底下，等一下會被球蓋掉上緣，只剩兩側露出來 */
    ctx.fillStyle = '#2A2118';
    for (const g of segs) {
      if (g.isHead || g.rr <= 3) continue;
      const kick = Math.sin(t * freq * 1.15 - g.i * 1.3);
      for (const side of [-1, 1]) {
        const k = side > 0 ? kick : -kick;
        ctx.beginPath();
        ctx.ellipse(g.x + side * g.rr * (0.72 + 0.08 * k), g.cy + g.rr * (0.80 + 0.06 * k),
          g.rr * 0.28, g.rr * 0.17, side * 0.35, 0, TAU);
        ctx.fill();
      }
    }

    /* 三、外框：整隻共用一圈。每顆球放大一點點畫成同一條路徑填深色，
     * 交集的地方自然合併，只留下整體的輪廓線。 */
    const lw = Math.max(0.6, segs[segs.length - 1].rr * 0.09);
    ctx.fillStyle = ch.bodyDark;
    ctx.beginPath();
    for (const g of segs) ctx.arc(g.x, g.cy, g.rr + lw, 0, TAU);
    ctx.fill();

    /* 四、球體本身。遠處的小球用實色就好 ——
     * createRadialGradient 每幀每顆都要重建，六隻毛毛蟲就是四十幾個漸層物件，
     * 實測那是這個畫面最貴的一項。 */
    for (const g of segs) {
      if (g.rr > 13) {
        const grd = ctx.createRadialGradient(g.x - g.rr * 0.36, g.cy - g.rr * 0.42, g.rr * 0.08,
          g.x, g.cy, g.rr * 1.12);
        grd.addColorStop(0, ch.bodyLight);
        grd.addColorStop(0.5, ch.body);
        /* 外緣收一點暗，節與節之間才看得出分界 ——
         * 但不是描邊：描邊疊在一起就變成一圈一圈的殘影。 */
        grd.addColorStop(0.88, ch.body);
        grd.addColorStop(1, ch.bodyDark);
        ctx.fillStyle = grd;
      } else {
        ctx.fillStyle = ch.body;
      }
      ctx.beginPath(); ctx.arc(g.x, g.cy, g.rr, 0, TAU); ctx.fill();
    }

    /* 五、花紋與臉，一樣由遠到近 */
    for (const g of segs) {
      if (g.isHead) continue;
      if (g.rr <= 4) continue;
      ctx.save();
      ctx.translate(g.x, g.cy - g.rr * 0.2);
      ctx.scale(1, 0.55);
      segPattern(ctx, ch.pattern, g.rr, ch.mark);
      ctx.restore();
    }
    const head = segs.find(g => g.isHead);
    if (head) drawFace(ctx, P, ch, head.x, head.cy, head.rr, o, alpha);

    /* 狀態：泡泡護盾 */
    const hp = P.pt(pts[0].x, pts[0].y, 0);
    if (hp.f > NEAR && hp.f < FAR) {
      const rr = HEAD_R * scale * hp.s;
      const cy = hp.y - (HEAD_R * scale + lift) * hp.s;
      if (o.shield && rr > 2) {
        ctx.save();
        ctx.globalAlpha = alpha * 0.5;
        const bg = ctx.createRadialGradient(hp.x - rr * 0.5, cy - rr * 0.6, rr * 0.3, hp.x, cy, rr * 3.4);
        bg.addColorStop(0, 'rgba(255,255,255,.85)');
        bg.addColorStop(0.72, 'rgba(160,230,255,.35)');
        bg.addColorStop(1, 'rgba(120,200,255,0)');
        ctx.fillStyle = bg;
        ctx.beginPath(); ctx.arc(hp.x, cy, rr * 3.4, 0, TAU); ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,.9)';
        ctx.lineWidth = Math.max(1, rr * 0.12);
        ctx.beginPath(); ctx.arc(hp.x, cy, rr * 3.2, 0, TAU); ctx.stroke();
        ctx.restore();
      }
      if (o.slow && !o.reduceMotion && rr > 2) {
        ctx.save();
        ctx.fillStyle = '#FFE9A8';
        for (let i = 0; i < 3; i++) {
          const a = t * 5 + i * TAU / 3;
          ctx.beginPath();
          ctx.arc(hp.x + Math.cos(a) * rr * 1.7, cy - rr * 1.9 + Math.sin(a) * rr * 0.4, Math.max(1, rr * 0.16), 0, TAU);
          ctx.fill();
        }
        ctx.restore();
      }
    }

    ctx.restore();
  }

  /* ================================================================
   *  六、給 UI 用的 SVG（選角、結算大頭貼）
   * ================================================================ */

  function wormSvg(ch, size) {
    const s = size || 96;
    const id = 'w' + ch.id;
    let body = '';
    for (let i = 4; i >= 1; i--) {
      const r = 12 - i * 0.7;
      body += '<circle cx="' + (30 + i * 13) + '" cy="' + (52 + Math.sin(i * 0.9) * 3) +
        '" r="' + r + '" fill="url(#' + id + '-b)" stroke="' + ch.bodyDark + '" stroke-width="1.2"/>';
    }
    return '<svg viewBox="0 0 110 96" width="' + s + '" height="' + (s * 96 / 110) + '" role="img" aria-label="' + ch.name + '">' +
      '<defs><radialGradient id="' + id + '-b" cx="0.35" cy="0.3" r="0.8">' +
      '<stop offset="0" stop-color="' + ch.bodyLight + '"/><stop offset="55%" stop-color="' + ch.body + '"/>' +
      '<stop offset="100%" stop-color="' + ch.bodyDark + '"/></radialGradient></defs>' +
      '<ellipse cx="55" cy="80" rx="42" ry="7" fill="rgba(0,0,0,.12)"/>' +
      body +
      '<path d="M30 40q-6-12-14-16" stroke="' + ch.bodyDark + '" stroke-width="2.4" fill="none" stroke-linecap="round"/>' +
      '<path d="M36 38q-2-14 4-20" stroke="' + ch.bodyDark + '" stroke-width="2.4" fill="none" stroke-linecap="round"/>' +
      '<circle cx="16" cy="24" r="3.4" fill="' + ch.horn + '"/>' +
      '<circle cx="40" cy="18" r="3.4" fill="' + ch.horn + '"/>' +
      '<circle cx="30" cy="50" r="15" fill="url(#' + id + '-b)" stroke="' + ch.bodyDark + '" stroke-width="1.3"/>' +
      '<ellipse cx="24" cy="45" rx="4.4" ry="5" fill="#fff"/><ellipse cx="34" cy="45" rx="4.4" ry="5" fill="#fff"/>' +
      '<circle cx="24.8" cy="46" r="2.5" fill="' + ch.eye + '"/><circle cx="34.8" cy="46" r="2.5" fill="' + ch.eye + '"/>' +
      '<circle cx="25.8" cy="45" r="1" fill="#fff"/><circle cx="35.8" cy="45" r="1" fill="#fff"/>' +
      '<ellipse cx="20" cy="54" rx="3" ry="2" fill="#FF8FA8" opacity=".55"/>' +
      '<ellipse cx="39" cy="54" rx="3" ry="2" fill="#FF8FA8" opacity=".55"/>' +
      '<path d="M25 56q4 4 9 0" stroke="' + ch.eye + '" stroke-width="1.6" fill="none" stroke-linecap="round"/>' +
      '</svg>';
  }

  root.Render = {
    SEGS, SEG_GAP, SEG_RUN, SEG_RISE, HEAD_R, NEAR, FAR, HORIZON, GRASS_SPAN, RUMBLE,
    AHEAD_NODES, BEHIND_NODES,
    makeCanvas, projector, sampleTrail, wormSvg, segPattern,
    buildScenery, drawProp, drawLeaf, drawWorm3D, drawFace,
    drawSky, drawGround, drawGroundBands, drawGroundTexture, drawFog, drawTunnelShade,
    drawSwayShade, SWAY, drawSpeedLines, trackFaces, trackDecals, groundBlob, curveAt,
    CAM_YAW, stepCamYaw, HEAD_CAM, headCamYaw,
    surfaceColors, mix, shade
  };
})(typeof self !== 'undefined' ? self : this);
