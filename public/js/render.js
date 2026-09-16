/* ===== render.js — Canvas 繪圖 =====
 *
 * 鏡頭跟隨自己的毛毛蟲，而且隨車頭旋轉（毛毛蟲永遠朝上）。
 * 因為整個世界會轉，靜態的賽道每一幀重畫太浪費，開局時先畫進一張離屏 canvas，
 * 之後每幀只要 drawImage 一次再疊上會動的東西。
 *
 * 全手繪向量，沒有任何 emoji 文字美術。
 */
(function (root) {
  'use strict';

  const TAU = Math.PI * 2;

  /* ================================================================
   *  一、毛毛蟲
   *  頭 ＋ 分節身體 ＋ 小腳 ＋ 觸角，漸層做立體感，不是圓球加臉。
   * ================================================================ */

  const SEGS = 6;          /* 身體節數（不含頭） */
  const SEG_GAP = 11;      /* 節與節的距離 */
  const HEAD_R = 11.5;

  /** 沿著軌跡往回取 n 個等距的點，當作身體各節的位置 */
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
      } else {
        acc += d; i++;
      }
    }
    /* 軌跡還不夠長（剛開局）就往後補 */
    while (out.length <= count) {
      const last = out[out.length - 1] || { x: hist[0].x, y: hist[0].y };
      out.push({ x: last.x, y: last.y + gap });
    }
    return out;
  }

  function segPattern(ctx, kind, r, color, phase) {
    ctx.fillStyle = color;
    if (kind === 'dot') {
      ctx.beginPath(); ctx.arc(0, 0, r * 0.34, 0, TAU); ctx.fill();
    } else if (kind === 'stripe') {
      ctx.fillRect(-r * 0.8, -r * 0.16, r * 1.6, r * 0.32);
    } else if (kind === 'heart') {
      const s = r * 0.42;
      ctx.beginPath();
      ctx.moveTo(0, s * 0.9);
      ctx.bezierCurveTo(-s * 1.6, -s * 0.3, -s * 0.5, -s * 1.3, 0, -s * 0.45);
      ctx.bezierCurveTo(s * 0.5, -s * 1.3, s * 1.6, -s * 0.3, 0, s * 0.9);
      ctx.fill();
    } else if (kind === 'wave') {
      ctx.strokeStyle = color; ctx.lineWidth = r * 0.22; ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-r * 0.75, 0);
      ctx.quadraticCurveTo(-r * 0.35, -r * 0.42, 0, 0);
      ctx.quadraticCurveTo(r * 0.35, r * 0.42, r * 0.75, 0);
      ctx.stroke();
    } else if (kind === 'star') {
      const s = r * 0.48;
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + i * Math.PI / 5;
        const rad = i % 2 ? s * 0.45 : s;
        ctx[i ? 'lineTo' : 'moveTo'](Math.cos(a) * rad, Math.sin(a) * rad);
      }
      ctx.closePath(); ctx.fill();
    } else if (kind === 'check') {
      const s = r * 0.32;
      ctx.fillRect(-s, -s, s, s);
      ctx.fillRect(0, 0, s, s);
    } else if (kind === 'leaf') {
      const s = r * 0.5;
      ctx.beginPath();
      ctx.moveTo(0, -s);
      ctx.quadraticCurveTo(s * 0.9, 0, 0, s);
      ctx.quadraticCurveTo(-s * 0.9, 0, 0, -s);
      ctx.fill();
    } else if (kind === 'tri') {
      const s = r * 0.46;
      ctx.beginPath();
      ctx.moveTo(0, -s); ctx.lineTo(s * 0.9, s * 0.6); ctx.lineTo(-s * 0.9, s * 0.6);
      ctx.closePath(); ctx.fill();
    }
  }

  /**
   * 畫一隻毛毛蟲。
   * @param {CanvasRenderingContext2D} ctx 已經套好世界座標
   * @param {object} ch   characters.js 的角色資料
   * @param {Array}  pts  身體各節的位置（[0] 是頭）
   * @param {object} o    { t, speed, wiggle, tiny, ghost, shield, hop, slow, reduceMotion }
   */
  function drawWorm(ctx, ch, pts, o) {
    const scale = o.tiny ? 0.72 : 1;
    const alpha = o.ghost ? 0.35 : 1;
    const t = o.t || 0;
    /* 蠕動幅度：平常小小起伏，衝刺時整隻大力波動 */
    const amp = o.reduceMotion ? 0 : (o.wiggle ? 2.6 : 1.1) * scale;
    const freq = o.wiggle ? 13 : 8;

    ctx.save();
    ctx.globalAlpha = alpha;

    /* 影子：先畫一整條，比較有重量 */
    if (!o.hop) {
      ctx.save();
      ctx.globalAlpha = alpha * 0.18;
      ctx.fillStyle = '#000';
      for (let i = pts.length - 1; i >= 0; i--) {
        const r = (i === 0 ? HEAD_R : HEAD_R * (0.94 - i * 0.055)) * scale;
        ctx.beginPath(); ctx.ellipse(pts[i].x + 2.5, pts[i].y + 3.5, r, r * 0.72, 0, 0, TAU); ctx.fill();
      }
      ctx.restore();
    } else {
      /* 飄在空中：影子離遠一點、淡一點 */
      ctx.save();
      ctx.globalAlpha = alpha * 0.12;
      ctx.fillStyle = '#000';
      for (let i = pts.length - 1; i >= 0; i--) {
        const r = (i === 0 ? HEAD_R : HEAD_R * (0.94 - i * 0.055)) * scale;
        ctx.beginPath(); ctx.ellipse(pts[i].x + 8, pts[i].y + 11, r * 0.9, r * 0.6, 0, 0, TAU); ctx.fill();
      }
      ctx.restore();
    }

    /* 身體：從尾巴往頭畫，後面的節被前面的蓋住，看起來才會一節一節 */
    for (let i = pts.length - 1; i >= 1; i--) {
      const p = pts[i];
      const prev = pts[i - 1];
      const ang = Math.atan2(p.y - prev.y, p.x - prev.x);
      const r = HEAD_R * (0.94 - (i - 1) * 0.062) * scale;
      /* 沿法線推一點點，做出蠕動的波形 */
      const wob = Math.sin(t * freq - i * 0.9) * amp;
      const px = p.x + Math.cos(ang + Math.PI / 2) * wob;
      const py = p.y + Math.sin(ang + Math.PI / 2) * wob;

      /* 小腳：一節兩隻，左右交替抬起 */
      ctx.save();
      ctx.translate(px, py); ctx.rotate(ang);
      const lift = Math.sin(t * freq * 1.15 - i * 1.3);
      ctx.strokeStyle = ch.bodyDark; ctx.lineWidth = 2.4 * scale; ctx.lineCap = 'round';
      for (const side of [-1, 1]) {
        const l = r * (0.62 + 0.18 * (side > 0 ? lift : -lift));
        ctx.beginPath();
        ctx.moveTo(0, side * r * 0.55);
        ctx.lineTo(-r * 0.15, side * (r * 0.55 + l));
        ctx.stroke();
      }
      ctx.restore();

      /* 節身：徑向漸層做立體感 */
      const g = ctx.createRadialGradient(px - r * 0.38, py - r * 0.42, r * 0.12, px, py, r * 1.05);
      g.addColorStop(0, ch.bodyLight);
      g.addColorStop(0.55, ch.body);
      g.addColorStop(1, ch.bodyDark);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(px, py, r, 0, TAU); ctx.fill();
      ctx.strokeStyle = ch.bodyDark; ctx.lineWidth = 1.1 * scale; ctx.stroke();

      /* 肚子（下緣亮一點）與花紋 */
      ctx.save();
      ctx.translate(px, py); ctx.rotate(ang);
      ctx.globalAlpha = alpha * 0.55;
      ctx.fillStyle = ch.belly;
      ctx.beginPath(); ctx.ellipse(0, r * 0.42, r * 0.62, r * 0.3, 0, 0, TAU); ctx.fill();
      ctx.globalAlpha = alpha;
      segPattern(ctx, ch.pattern, r, ch.mark, i);
      ctx.restore();
    }

    /* 頭 */
    const h = pts[0], nx = pts[1] || pts[0];
    const hang = Math.atan2(h.y - nx.y, h.x - nx.x);
    const hr = HEAD_R * scale;
    ctx.save();
    ctx.translate(h.x, h.y); ctx.rotate(hang);

    /* 觸角 */
    ctx.strokeStyle = ch.bodyDark; ctx.lineWidth = 2 * scale; ctx.lineCap = 'round';
    for (const side of [-1, 1]) {
      const sway = Math.sin(t * freq * 0.7 + side) * 0.18;
      ctx.beginPath();
      ctx.moveTo(hr * 0.25, side * hr * 0.5);
      ctx.quadraticCurveTo(hr * 0.9, side * hr * (1.15 + sway), hr * 1.25, side * hr * (1.4 + sway));
      ctx.stroke();
      ctx.fillStyle = ch.horn;
      ctx.beginPath(); ctx.arc(hr * 1.25, side * hr * (1.4 + sway), hr * 0.26, 0, TAU); ctx.fill();
    }

    const hg = ctx.createRadialGradient(-hr * 0.15, -hr * 0.42, hr * 0.12, 0, 0, hr * 1.1);
    hg.addColorStop(0, ch.bodyLight);
    hg.addColorStop(0.5, ch.body);
    hg.addColorStop(1, ch.bodyDark);
    ctx.fillStyle = hg;
    ctx.beginPath(); ctx.arc(0, 0, hr, 0, TAU); ctx.fill();
    ctx.strokeStyle = ch.bodyDark; ctx.lineWidth = 1.2 * scale; ctx.stroke();

    /* 臉：眼睛朝前（+x），所以往右邊擺 */
    ctx.fillStyle = '#fff';
    for (const side of [-1, 1]) {
      ctx.beginPath(); ctx.ellipse(hr * 0.34, side * hr * 0.42, hr * 0.3, hr * 0.34, 0, 0, TAU); ctx.fill();
    }
    ctx.fillStyle = ch.eye;
    for (const side of [-1, 1]) {
      ctx.beginPath(); ctx.arc(hr * 0.44, side * hr * 0.42, hr * 0.17, 0, TAU); ctx.fill();
    }
    ctx.fillStyle = '#fff';
    for (const side of [-1, 1]) {
      ctx.beginPath(); ctx.arc(hr * 0.5, side * hr * 0.42 - hr * 0.08, hr * 0.07, 0, TAU); ctx.fill();
    }
    /* 腮紅與笑臉 */
    ctx.globalAlpha = alpha * 0.5;
    ctx.fillStyle = '#FF8FA8';
    for (const side of [-1, 1]) {
      ctx.beginPath(); ctx.ellipse(hr * 0.05, side * hr * 0.66, hr * 0.2, hr * 0.13, 0, 0, TAU); ctx.fill();
    }
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = ch.eye; ctx.lineWidth = 1.5 * scale; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(hr * 0.62, 0, hr * 0.3, -0.9, 0.9); ctx.stroke();
    ctx.restore();

    /* 狀態：泡泡護盾、飄浮光暈、被黏住的星星 */
    if (o.shield) {
      ctx.save();
      ctx.globalAlpha = alpha * 0.55;
      const bg = ctx.createRadialGradient(h.x - 6, h.y - 8, 4, h.x, h.y, hr * 3.1);
      bg.addColorStop(0, 'rgba(255,255,255,.85)');
      bg.addColorStop(0.7, 'rgba(160,230,255,.35)');
      bg.addColorStop(1, 'rgba(120,200,255,0)');
      ctx.fillStyle = bg;
      ctx.beginPath(); ctx.arc(h.x, h.y, hr * 3.1, 0, TAU); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(h.x, h.y, hr * 3.0, 0, TAU); ctx.stroke();
      ctx.restore();
    }
    if (o.slow && !o.reduceMotion) {
      ctx.save();
      ctx.globalAlpha = alpha * 0.9;
      ctx.fillStyle = '#FFE9A8';
      for (let i = 0; i < 3; i++) {
        const a = t * 5 + i * TAU / 3;
        ctx.beginPath();
        ctx.arc(h.x + Math.cos(a) * hr * 1.9, h.y - hr * 1.7 + Math.sin(a) * hr * 0.5, 2.4, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }
    ctx.restore();
  }

  /* ---------- 給 UI 用的 SVG 版本（選角、結算大頭貼） ---------- */

  function wormSvg(ch, size) {
    const s = size || 96;
    const id = 'w' + ch.id;
    const seg = (cx, r, i) =>
      '<circle cx="' + cx + '" cy="' + (52 + Math.sin(i * 0.9) * 3) + '" r="' + r + '" fill="url(#' + id + '-b)" stroke="' + ch.bodyDark + '" stroke-width="1.2"/>';
    let body = '';
    for (let i = 4; i >= 1; i--) body += seg(30 + i * 13, 12 - i * 0.7, i);
    return '<svg viewBox="0 0 110 96" width="' + s + '" height="' + (s * 96 / 110) + '" role="img" aria-label="' + ch.name + '">' +
      '<defs>' +
      '<radialGradient id="' + id + '-b" cx="0.35" cy="0.3" r="0.8">' +
      '<stop offset="0" stop-color="' + ch.bodyLight + '"/><stop offset="55%" stop-color="' + ch.body + '"/>' +
      '<stop offset="100%" stop-color="' + ch.bodyDark + '"/></radialGradient>' +
      '</defs>' +
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

  /* ================================================================
   *  二、靜態賽道（開局畫一次，之後只 drawImage）
   * ================================================================ */

  function makeCanvas(w, h) {
    const c = (typeof document !== 'undefined')
      ? document.createElement('canvas')
      : { width: w, height: h, getContext: () => null };
    c.width = w; c.height = h;
    return c;
  }

  function ribbonPath(ctx, nodes, closed, grow) {
    const n = nodes.length;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const nd = nodes[i], w = nd.w + (grow || 0);
      const x = nd.x + nd.nx * w, y = nd.y + nd.ny * w;
      ctx[i ? 'lineTo' : 'moveTo'](x, y);
    }
    for (let i = n - 1; i >= 0; i--) {
      const nd = nodes[i], w = nd.w + (grow || 0);
      ctx.lineTo(nd.x - nd.nx * w, nd.y - nd.ny * w);
    }
    ctx.closePath();
  }

  /**
   * 只走「兩條側邊」的路徑，不含頭尾封口。
   *
   * ribbonPath 是一個封閉多邊形（沿左緣去、沿右緣回），用來填色很好用；
   * 但拿去描邊時，頭尾那兩條封口線也會被描出來 ——
   * 捷徑是開放路徑，封口剛好橫跨主賽道，結果在路面上留下一條直直的假接縫。
   * 所以描邊一律走這一支。
   */
  function ribbonEdges(ctx, nodes, closed, grow) {
    const n = nodes.length;
    ctx.beginPath();
    for (const side of [1, -1]) {
      for (let i = 0; i < n; i++) {
        const nd = nodes[i], w = (nd.w + (grow || 0)) * side;
        const x = nd.x + nd.nx * w, y = nd.y + nd.ny * w;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      if (closed) ctx.closePath();
    }
  }

  /** 開局把賽道畫進離屏 canvas。回傳 { canvas, ox, oy } */
  function buildTrack(track, theme, rng) {
    const b = track.bounds;
    const w = Math.ceil(b.maxX - b.minX), h = Math.ceil(b.maxY - b.minY);
    const cv = makeCanvas(w, h);
    const ctx = cv.getContext('2d');
    if (!ctx) return { canvas: cv, ox: b.minX, oy: b.minY };
    ctx.translate(-b.minX, -b.minY);

    /* 草地底色 ＋ 一點點深淺變化，不要一片死板的綠 */
    ctx.fillStyle = theme.grass;
    ctx.fillRect(b.minX, b.minY, w, h);
    ctx.fillStyle = theme.grassAlt;
    for (let i = 0; i < 260; i++) {
      const x = b.minX + rng.next() * w, y = b.minY + rng.next() * h;
      ctx.globalAlpha = 0.25 + rng.next() * 0.25;
      ctx.beginPath();
      ctx.ellipse(x, y, 20 + rng.next() * 46, 14 + rng.next() * 26, rng.next() * Math.PI, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    /* ================================================================
     *  跑道：做成「被切進草地裡」的凹陷路面，才有立體感
     *
     *  光源固定在左上，所以：
     *    1. 草地被切開的斷面（路肩）畫在跑道外圈，草地看起來就有厚度
     *    2. 跑道內側左上有草牆投下來的陰影
     *    3. 跑道內側右下有一條邊光（對面的斜坡受光）
     *    4. 草地的上緣（左上）有一條亮邊，像切口被照到
     *  這四層疊起來，平面的色塊就會讀成「路面比草地低一階」。
     * ================================================================ */

    const LIGHT = { x: -1, y: -1.25 };      /* 光從左上來 */
    const BANK = 27;                        /* 路肩（草地斷面）的厚度 */
    const ribbons = [track.nodes].concat(track.shortcuts.map(s => s.nodes));

    /* 1. 草地斷面：比跑道大一圈的深色帶，等於草皮被切開露出的側面 */
    for (const nodes of ribbons) {
      ribbonPath(ctx, nodes, true, BANK);
      ctx.fillStyle = theme.grassDark;
      ctx.fill();
    }
    /* 草地上緣受光的亮線：把斷面往光的方向推一點點再描一次 */
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.translate(LIGHT.x * 3, LIGHT.y * 3);
    for (const nodes of ribbons) {
      ribbonEdges(ctx, nodes, nodes === track.nodes, BANK);
      ctx.strokeStyle = theme.grassAlt;
      ctx.lineWidth = 5;
      ctx.stroke();
    }
    ctx.restore();

    /* 2. 沙土邊與路面 */
    for (const nodes of ribbons) {
      ribbonPath(ctx, nodes, true, 8);
      ctx.fillStyle = theme.roadEdge;
      ctx.fill();
    }
    for (const nodes of ribbons) {
      ribbonPath(ctx, nodes, true, 0);
      ctx.fillStyle = theme.road;
      ctx.fill();
    }

    /* 3. 路面內側的陰影與邊光。
     *    先把畫筆夾在路面裡，再把路面輪廓往光的反方向推去描粗線 ——
     *    推出去的那半邊會被夾掉，只剩「草牆投在路上」的那一半留下來。 */
    for (const nodes of ribbons) {
      ctx.save();
      ribbonPath(ctx, nodes, true, 0);
      ctx.clip();

      const loop = nodes === track.nodes;

      ctx.save();
      ctx.translate(-LIGHT.x * 9, -LIGHT.y * 9);
      ribbonEdges(ctx, nodes, loop, 0);
      ctx.strokeStyle = 'rgba(0,0,0,.34)';
      ctx.lineWidth = 30;
      ctx.stroke();
      ctx.restore();

      ctx.save();
      ctx.translate(LIGHT.x * 6, LIGHT.y * 6);
      ribbonEdges(ctx, nodes, loop, 0);
      ctx.strokeStyle = 'rgba(255,255,255,.26)';
      ctx.lineWidth = 13;
      ctx.stroke();
      ctx.restore();

      ctx.restore();
    }

    /* 4. 路面的橫紋：跑起來才看得出速度 */
    ctx.save();
    ctx.globalAlpha = 0.12;
    ctx.strokeStyle = theme.roadDark;
    ctx.lineWidth = 2;
    for (const nodes of ribbons) {
      for (let i = 0; i < nodes.length; i += 3) {
        const nd = nodes[i];
        ctx.beginPath();
        ctx.moveTo(nd.x + nd.nx * nd.w * 0.82, nd.y + nd.ny * nd.w * 0.82);
        ctx.lineTo(nd.x - nd.nx * nd.w * 0.82, nd.y - nd.ny * nd.w * 0.82);
        ctx.stroke();
      }
    }
    ctx.restore();

    /* 5. 彎道緣石：紅白相間的小塊，有上亮下暗的斜面。
     *    除了好看，它也是「這裡是彎道」的提示，遠遠就看得到。 */
    drawCurbs(ctx, track.nodes);
    for (const sc of track.shortcuts) drawCurbs(ctx, sc.nodes);

    /* 泥巴坑：畫成凹下去的水窪 —— 上緣有陰影、下緣有反光，中間深 */
    for (const m of track.mud) {
      const g = ctx.createRadialGradient(m.x, m.y - m.r * 0.15, m.r * 0.1, m.x, m.y, m.r);
      g.addColorStop(0, theme.mud);
      g.addColorStop(0.7, theme.mud);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(m.x, m.y, m.r, 0, TAU); ctx.fill();

      ctx.save();
      ctx.beginPath(); ctx.arc(m.x, m.y, m.r * 0.96, 0, TAU); ctx.clip();
      ctx.strokeStyle = 'rgba(0,0,0,.35)';
      ctx.lineWidth = 10;
      ctx.beginPath(); ctx.arc(m.x - LIGHT.x * 5, m.y - LIGHT.y * 5, m.r * 0.94, 0, TAU); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,.22)';
      ctx.lineWidth = 6;
      ctx.beginPath(); ctx.arc(m.x + LIGHT.x * 4, m.y + LIGHT.y * 4, m.r * 0.94, 0, TAU); ctx.stroke();
      ctx.restore();

      ctx.globalAlpha = 0.3;
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.ellipse(m.x - m.r * 0.22, m.y - m.r * 0.28, m.r * 0.28, m.r * 0.14, -0.4, 0, TAU); ctx.fill();
      ctx.globalAlpha = 1;
    }

    /* 加速帶：順著賽道方向的發光露珠帶。
     * 箭頭要跟著跑道轉，不然玩家會以為那是往畫面右邊的意思。 */
    for (const p of track.boosts) {
      /* 找最近的節點借它的方向 */
      let best = track.nodes[0], bestD = Infinity;
      for (const nd of track.nodes) {
        const d = (nd.x - p.x) * (nd.x - p.x) + (nd.y - p.y) * (nd.y - p.y);
        if (d < bestD) { bestD = d; best = nd; }
      }
      const ang = Math.atan2(best.ty, best.tx);

      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(ang);

      const g = ctx.createRadialGradient(0, 0, p.r * 0.08, 0, 0, p.r);
      g.addColorStop(0, 'rgba(255,255,255,.95)');
      g.addColorStop(0.42, theme.boost);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.ellipse(0, 0, p.r, p.r * 0.86, 0, 0, TAU); ctx.fill();

      /* 三個往前的箭頭，前面的比較亮 */
      for (let k = 0; k < 3; k++) {
        const x = (k - 1) * p.r * 0.46;
        ctx.globalAlpha = 0.45 + k * 0.22;
        ctx.fillStyle = '#FFFFFF';
        ctx.beginPath();
        ctx.moveTo(x - p.r * 0.2, -p.r * 0.42);
        ctx.lineTo(x + p.r * 0.22, 0);
        ctx.lineTo(x - p.r * 0.2, p.r * 0.42);
        ctx.lineTo(x - p.r * 0.05, 0);
        ctx.closePath(); ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    /* 起跑線／終點線：黑白格 */
    const s0 = track.nodes[track.starts[0] ? 0 : 0];
    const line = track.nodes[0];
    ctx.save();
    ctx.translate(line.x, line.y);
    ctx.rotate(Math.atan2(line.ty, line.tx));
    const lw = line.w;
    for (let i = -Math.ceil(lw / 11); i < Math.ceil(lw / 11); i++) {
      for (let j = 0; j < 2; j++) {
        ctx.fillStyle = ((i + j) % 2) ? '#2C2C2C' : '#FFFFFF';
        ctx.fillRect(-11 + j * 11, i * 11, 11, 11);
      }
    }
    ctx.restore();

    /* 石頭與樹幹：一樣用左上光源做立體 ——
     * 接地陰影 ＋ 左上高光 ＋ 右下反光 ＋ 上面長的苔蘚，不要只是一顆灰色圓餅。 */
    for (const rk of track.rocks) {
      /* 接地陰影：貼著地面往右下扁扁地攤開 */
      ctx.save();
      ctx.globalAlpha = 0.26;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.ellipse(rk.x - LIGHT.x * 7, rk.y - LIGHT.y * 9, rk.r * 1.02, rk.r * 0.82, 0, 0, TAU);
      ctx.fill();
      ctx.restore();

      /* 石體 */
      const g = ctx.createRadialGradient(
        rk.x + LIGHT.x * rk.r * 0.34, rk.y + LIGHT.y * rk.r * 0.3, rk.r * 0.06,
        rk.x, rk.y, rk.r * 1.12);
      g.addColorStop(0, theme.rock);
      g.addColorStop(0.55, theme.rock);
      g.addColorStop(1, theme.rockDark);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(rk.x, rk.y, rk.r, 0, TAU); ctx.fill();

      ctx.save();
      ctx.beginPath(); ctx.arc(rk.x, rk.y, rk.r, 0, TAU); ctx.clip();
      /* 左上高光 */
      ctx.globalAlpha = 0.3;
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.ellipse(rk.x + LIGHT.x * rk.r * 0.42, rk.y + LIGHT.y * rk.r * 0.36,
        rk.r * 0.5, rk.r * 0.34, -0.7, 0, TAU);
      ctx.fill();
      /* 右下反光：讓下緣不會黑成一片 */
      ctx.globalAlpha = 0.16;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = rk.r * 0.16;
      ctx.beginPath();
      ctx.arc(rk.x - LIGHT.x * rk.r * 0.1, rk.y - LIGHT.y * rk.r * 0.1, rk.r * 0.9, 0, TAU);
      ctx.stroke();
      ctx.globalAlpha = 1;

      /* 石頭上的裂紋，讓它不是一顆光滑的球 */
      ctx.globalAlpha = 0.22;
      ctx.strokeStyle = theme.rockDark;
      ctx.lineWidth = Math.max(1.5, rk.r * 0.045);
      for (let i = 0; i < 3; i++) {
        const a0 = rng.next() * TAU;
        ctx.beginPath();
        ctx.moveTo(rk.x + Math.cos(a0) * rk.r * 0.2, rk.y + Math.sin(a0) * rk.r * 0.2);
        ctx.lineTo(rk.x + Math.cos(a0 + 0.5) * rk.r * 0.75, rk.y + Math.sin(a0 + 0.5) * rk.r * 0.75);
        ctx.stroke();
      }
      ctx.restore();

      ctx.strokeStyle = theme.rockDark;
      ctx.lineWidth = 2.2;
      ctx.beginPath(); ctx.arc(rk.x, rk.y, rk.r - 1, 0, TAU); ctx.stroke();

      /* 上面長的苔蘚（受光的那一側多一點），順便讓大石頭看起來像花圃 */
      for (let i = 0; i < Math.max(3, rk.r / 16); i++) {
        const a0 = rng.next() * TAU;
        const rr = rk.r * (0.25 + rng.next() * 0.6);
        const mx = rk.x + Math.cos(a0) * rr, my = rk.y + Math.sin(a0) * rr;
        const lit = (Math.cos(a0) * LIGHT.x + Math.sin(a0) * LIGHT.y) > 0;
        ctx.fillStyle = lit ? theme.grassAlt : theme.grassDark;
        ctx.beginPath();
        ctx.ellipse(mx, my, rk.r * 0.17, rk.r * 0.1, a0, 0, TAU);
        ctx.fill();
      }
    }

    /* 草地上的小裝飾 */
    drawDecor(ctx, track, theme, rng);

    /* 世界邊界畫成一圈樹籬：撞到會彈開，所以要讓玩家看得出來那是牆 */
    ctx.save();
    ctx.strokeStyle = theme.grassDark;
    ctx.lineWidth = 46;
    ctx.strokeRect(b.minX + 23, b.minY + 23, w - 46, h - 46);
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = theme.rockDark;
    ctx.lineWidth = 6;
    ctx.strokeRect(b.minX + 46, b.minY + 46, w - 92, h - 92);
    ctx.restore();

    return { canvas: cv, ox: b.minX, oy: b.minY, w, h };
  }

  /**
   * 彎道緣石：只在彎得夠兇的地方畫，紅白相間，上緣亮下緣暗做出斜面。
   */
  function drawCurbs(ctx, nodes) {
    const n = nodes.length;
    let block = 0;
    for (let i = 0; i < n; i += 2) {
      const a = nodes[(i - 4 + n) % n], b = nodes[(i + 4) % n], nd = nodes[i];
      const cross = a.tx * b.ty - a.ty * b.tx;
      const dot = a.tx * b.tx + a.ty * b.ty;
      const curve = Math.abs(Math.atan2(cross, dot));
      if (curve < 0.16) { block = 0; continue; }
      block++;
      const red = (block >> 1) % 2 === 0;
      const len = 14;
      for (const side of [-1, 1]) {
        const ox = nd.nx * side * (nd.w + 9), oy = nd.ny * side * (nd.w + 9);
        ctx.save();
        ctx.translate(nd.x + ox, nd.y + oy);
        ctx.rotate(Math.atan2(nd.ty, nd.tx));
        ctx.fillStyle = red ? '#E2564E' : '#FDF6EA';
        ctx.fillRect(-len / 2, -5, len, 10);
        ctx.fillStyle = 'rgba(255,255,255,.55)';
        ctx.fillRect(-len / 2, -5, len, 2.6);
        ctx.fillStyle = 'rgba(0,0,0,.28)';
        ctx.fillRect(-len / 2, 2.6, len, 2.4);
        ctx.restore();
      }
    }
  }

  function drawDecor(ctx, track, theme, rng) {
    const b = track.bounds;
    const Tr = root.Tracks;
    let tries = 0, placed = 0;
    while (placed < 190 && tries < 2600) {
      tries++;
      const x = b.minX + rng.next() * (b.maxX - b.minX);
      const y = b.minY + rng.next() * (b.maxY - b.minY);
      if (Tr && Tr.surfaceAt(track, x, y) !== Tr.SURFACE.GRASS) continue;
      let nearRock = false;
      for (const rk of track.rocks) if (Math.hypot(rk.x - x, rk.y - y) < rk.r + 10) nearRock = true;
      if (nearRock) continue;
      placed++;
      const kind = theme.decor[Math.floor(rng.next() * theme.decor.length)];
      const s = 4 + rng.next() * 5;
      ctx.save();
      ctx.translate(x, y);
      if (kind === 'flower') {
        ctx.fillStyle = ['#FF8FB1', '#FFE066', '#C39BFF', '#FFFFFF'][Math.floor(rng.next() * 4)];
        for (let i = 0; i < 5; i++) {
          const a = i * TAU / 5;
          ctx.beginPath(); ctx.ellipse(Math.cos(a) * s * 0.55, Math.sin(a) * s * 0.55, s * 0.4, s * 0.28, a, 0, TAU); ctx.fill();
        }
        ctx.fillStyle = '#FFD54A';
        ctx.beginPath(); ctx.arc(0, 0, s * 0.3, 0, TAU); ctx.fill();
      } else if (kind === 'clover' || kind === 'leaf') {
        ctx.fillStyle = theme.grassDark;
        for (let i = 0; i < 3; i++) {
          const a = i * TAU / 3 - 0.5;
          ctx.beginPath(); ctx.ellipse(Math.cos(a) * s * 0.5, Math.sin(a) * s * 0.5, s * 0.42, s * 0.3, a, 0, TAU); ctx.fill();
        }
      } else if (kind === 'pebble') {
        ctx.fillStyle = theme.rock;
        ctx.beginPath(); ctx.ellipse(0, 0, s * 0.7, s * 0.5, rng.next(), 0, TAU); ctx.fill();
      } else if (kind === 'carrot') {
        ctx.fillStyle = '#FF9A3D';
        ctx.beginPath(); ctx.moveTo(0, s); ctx.lineTo(-s * 0.4, -s * 0.3); ctx.lineTo(s * 0.4, -s * 0.3); ctx.closePath(); ctx.fill();
        ctx.fillStyle = theme.grassDark;
        ctx.beginPath(); ctx.ellipse(0, -s * 0.55, s * 0.5, s * 0.25, 0, 0, TAU); ctx.fill();
      } else if (kind === 'acorn' || kind === 'twig') {
        ctx.fillStyle = '#B07C4A';
        ctx.beginPath(); ctx.ellipse(0, 0, s * 0.45, s * 0.6, rng.next(), 0, TAU); ctx.fill();
      } else if (kind === 'reed' || kind === 'splash') {
        ctx.strokeStyle = theme.grassDark; ctx.lineWidth = 1.6; ctx.lineCap = 'round';
        for (let i = -1; i <= 1; i++) {
          ctx.beginPath(); ctx.moveTo(i * s * 0.35, s * 0.6); ctx.quadraticCurveTo(i * s * 0.6, -s * 0.2, i * s * 0.2, -s); ctx.stroke();
        }
      } else if (kind === 'candy' || kind === 'sprinkle') {
        ctx.fillStyle = ['#FF7A9A', '#7FD8F5', '#FFE066', '#A886E8'][Math.floor(rng.next() * 4)];
        ctx.save(); ctx.rotate(rng.next() * TAU);
        ctx.fillRect(-s * 0.55, -s * 0.2, s * 1.1, s * 0.4);
        ctx.restore();
      } else if (kind === 'cookie') {
        ctx.fillStyle = '#D9A86B';
        ctx.beginPath(); ctx.arc(0, 0, s * 0.62, 0, TAU); ctx.fill();
        ctx.fillStyle = '#6A4322';
        for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.arc((rng.next() - 0.5) * s * 0.7, (rng.next() - 0.5) * s * 0.7, s * 0.12, 0, TAU); ctx.fill(); }
      } else if (kind === 'shroom' || kind === 'glow') {
        ctx.fillStyle = '#E8E0F8';
        ctx.fillRect(-s * 0.16, -s * 0.1, s * 0.32, s * 0.7);
        ctx.fillStyle = kind === 'glow' ? '#8BF0E0' : '#B7A6F0';
        ctx.beginPath(); ctx.ellipse(0, -s * 0.15, s * 0.6, s * 0.42, 0, Math.PI, TAU); ctx.fill();
      }
      ctx.restore();
    }
  }

  root.Render = {
    SEGS, SEG_GAP, HEAD_R,
    drawWorm, wormSvg, sampleTrail, buildTrack, ribbonPath, ribbonEdges, segPattern, makeCanvas
  };
})(typeof self !== 'undefined' ? self : this);
