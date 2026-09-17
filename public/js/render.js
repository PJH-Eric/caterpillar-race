/* ===== render.js — 真透視的追尾視角渲染器 =====
 *
 * 為什麼不是俯視了：俯視加上「鏡頭跟著車頭轉」會暈 ——
 * 蠕動衝刺本來就要求玩家每 0.26 秒換一次邊，車頭因此以每秒兩次的頻率左右擺，
 * 整個世界跟著抖。改成追尾視角之後地平線永遠水平，毛毛蟲在畫面前方扭來扭去，
 * 世界卻是穩的；順便也真的變成立體畫面。
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

  function lerpNode(a, b, t) {
    return {
      x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t,
      w: a.w + (b.w - a.w) * t,
      nx: a.nx + (b.nx - a.nx) * t, ny: a.ny + (b.ny - a.ny) * t,
      i: a.i
    };
  }

  /** 賽道在某節點彎得多兇（決定要不要畫紅白緣石） */
  function curveAt(nodes, i, span, open) {
    const n = nodes.length;
    const wrap = j => (open ? Math.max(0, Math.min(n - 1, j)) : ((j % n) + n) % n);
    const a = nodes[wrap(i - span)], b = nodes[wrap(i + span)];
    return Math.abs(Math.atan2(a.tx * b.ty - a.ty * b.tx, a.tx * b.tx + a.ty * b.ty));
  }

  function makeSegDraw(P, a, b, theme, band, corner) {
    return function (ctx) {
      function quad(extra, fill) {
        const wa = a.w + extra, wb = b.w + extra;
        const p1 = P.pt(a.x + a.nx * wa, a.y + a.ny * wa, 0);
        const p2 = P.pt(b.x + b.nx * wb, b.y + b.ny * wb, 0);
        const p3 = P.pt(b.x - b.nx * wb, b.y - b.ny * wb, 0);
        const p4 = P.pt(a.x - a.nx * wa, a.y - a.ny * wa, 0);
        ctx.fillStyle = fill;
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y);
        ctx.lineTo(p3.x, p3.y); ctx.lineTo(p4.x, p4.y);
        ctx.closePath(); ctx.fill();
      }
      /* 只畫緣石與路面。
       * 本來每一段還會畫一條 GRASS_SPAN 寬的草地帶（OutRun 那種做法），
       * 但那條草地帶投影出來是一條橫跨整個畫面的長條 ——
       * 賽道繞回來的時候，近處那段的草地帶就把遠處的賽道整個蓋掉了。
       * 草地改成 drawGroundBands() 畫成不隨賽道走的水平條紋。 */
      quad(RUMBLE, corner ? (band ? '#E2564E' : '#FDF6EA') : theme.roadEdge);
      quad(0, theme.road);
      /* 速度感靠很淡的深色條紋疊上去就好。
       * 本來是 road / roadDark 兩色互換，夜光蘑菇那種色差大的主題會變成斑馬線。 */
      if (band) {
        ctx.save();
        ctx.globalAlpha = 0.09;
        quad(0, '#000000');
        ctx.restore();
      }
    };
  }

  /** 收集賽道的地面多邊形。回傳的東西由呼叫端依距離排序後畫。 */
  function trackFaces(P, track, fromNode, theme, out) {
    const nodes = track.nodes, n = nodes.length;
    const idxs = [];
    /* 近處畫細、遠處畫粗（LOD），不然遠方在畫一堆一像素的四邊形 */
    for (let i = -BEHIND_NODES; i < AHEAD_NODES;) {
      idxs.push(i);
      i += i < 18 ? 1 : (i < 46 ? 3 : 7);
    }
    idxs.push(AHEAD_NODES);

    for (let k = 0; k < idxs.length - 1; k++) {
      const wrap = j => (track.open ? Math.max(0, Math.min(n - 1, j)) : ((j % n) + n) % n);
      const ia = wrap(fromNode + idxs[k]);
      const ib = wrap(fromNode + idxs[k + 1]);
      if (ia === ib) continue;                /* 衝刺賽道夾到端點之後會重複，跳過 */
      const A = nodes[ia], B = nodes[ib];
      let fa = P.fwd(A.x, A.y), fb = P.fwd(B.x, B.y);
      if (fa < NEAR && fb < NEAR) continue;
      if (fa > FAR && fb > FAR) continue;

      /* 視錐裁切：賽道是封閉迴圈，往前數一百多個節點之後會繞回鏡頭旁邊，
       * 那些段的 f 很小、橫向偏移卻是好幾千，畫出來就是一片橫跨畫面的破面。
       * 兩端都落在視野外（橫向／前方 > 1.9，約 62 度）就整段跳過。 */
      const ra = -(A.x - P.cam.x) * P.sin + (A.y - P.cam.y) * P.cos;
      const rb = -(B.x - P.cam.x) * P.sin + (B.y - P.cam.y) * P.cos;
      const wa2 = A.w + GRASS_SPAN * 0, wb2 = B.w;
      const outA = fa < NEAR || Math.abs(ra) / Math.max(fa, 1) > 1.9 + wa2 / Math.max(fa, 1);
      const outB = fb < NEAR || Math.abs(rb) / Math.max(fb, 1) > 1.9 + wb2 / Math.max(fb, 1);
      if (outA && outB) continue;

      let a = { x: A.x, y: A.y, w: A.w, nx: A.nx, ny: A.ny, i: ia };
      let b = { x: B.x, y: B.y, w: B.w, nx: B.nx, ny: B.ny, i: ib };
      /* 近平面裁剪：太近的那一端往另一端拉到 NEAR */
      if (fa < NEAR) { a = lerpNode(a, b, (NEAR - fa) / (fb - fa)); fa = NEAR; }
      if (fb < NEAR) { b = lerpNode(b, a, (NEAR - fb) / (fa - fb)); fb = NEAR; }

      out.push({
        f: (fa + fb) / 2,
        draw: makeSegDraw(P, a, b, theme, Math.floor(ia / 5) % 2, curveAt(nodes, ia, 5, track.open) > 0.14)
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
     * 環狀賽道的終點就是起點（node 0）；衝刺賽道的終點在最後一個節點。 */
    const n0 = track.nodes[track.open ? track.nodes.length - 2 : 0];
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
  const TALL = { tree: 1, candycane: 1, lolly: 1, mushroom: 1, glowbud: 1 };

  const PROPS = {
    garden: ['tree', 'bush', 'flower', 'flower', 'bush'],
    veggie: ['bush', 'carrot', 'flower', 'bush', 'tree'],
    branch: ['tree', 'tree', 'bush', 'acorn'],
    pond: ['reed', 'bush', 'reed', 'flower', 'tree'],
    candy: ['candycane', 'lolly', 'bush', 'lolly'],
    shroom: ['mushroom', 'mushroom', 'glowbud', 'mushroom'],
    beach: ['reed', 'bush', 'reed', 'tree', 'reed'],
    canyon: ['bush', 'acorn', 'bush', 'tree'],
    snow: ['tree', 'bush', 'tree', 'bush']
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
   * @param {object} o  { t, angle, wiggle, tiny, ghost, shield, hop, slow, reduceMotion, isMe }
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
    drawSky, drawGround, drawGroundBands, drawGroundTexture, drawFog, drawSpeedLines, trackFaces, trackDecals, groundBlob, curveAt
  };
})(typeof self !== 'undefined' ? self : this);
