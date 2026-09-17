/* ===== tracks.js — 賽道幾何、地形網格、檢查點 =====
 *
 * 一張賽道由「手設的控制點」定義，經 Catmull-Rom 平滑後重新依距離取樣成等間距節點。
 * 節點同時負責三件事：
 *   1. 畫面上的跑道形狀（節點 ＋ 半寬 → 左右邊線）
 *   2. 地形查詢（把跑道燒進一張粗網格，查地形是 O(1)）
 *   3. 進度與計圈（最近節點 index → 檢查點 → 圈數）
 *
 * 瀏覽器與伺服器共用同一份，同一個 seed 一定長出同一張賽道。
 */
(function (root, factory) {
  'use strict';
  const RNG = (typeof module === 'object' && module.exports) ? require('./rng.js') : root.RNG;
  const api = factory(RNG);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Tracks = api;
})(typeof self !== 'undefined' ? self : this, function (RNG) {
  'use strict';

  /* ---------- 地形代碼 ---------- */

  const SURFACE = {
    GRASS: 0,   /* 賽道外的草地，可以走但很慢 */
    TRACK: 1,   /* 正常跑道 */
    MUD: 2,     /* 泥巴坑 */
    BOOST: 3    /* 露珠加速帶 */
  };

  /** 每格幾個世界單位。12 夠細（毛毛蟲寬 14），又不會讓網格太大。 */
  const CELL = 12;
  /** 等間距取樣的節點間隔 */
  const NODE_STEP = 14;
  /** 每圈切成幾個檢查點（必須依序通過，杜絕倒車刷圈） */
  const CHECKPOINTS = 12;
  /** 起跑線前方用來挑選直線段的節點數（每格 14 世界單位）。 */
  const START_STRAIGHT_NODES = 12;
  /** 八個選手在同一排時的橫向間距。 */
  const START_LANE_GAP = 28;

  /* ---------- Catmull-Rom ---------- */

  function catmull(p0, p1, p2, p3, t) {
    const t2 = t * t, t3 = t2 * t;
    return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
  }

  /**
   * 把控制點展開成密集點，再依距離重新取樣成等間距節點。
   * @param {Array<[number,number,number]>} ctrl 控制點 [x, y, 半寬]
   * @param {boolean} closed 是否閉環（主賽道閉環，捷徑不閉環）
   */
  function sample(ctrl, closed) {
    const n = ctrl.length;
    const dense = [];
    const last = closed ? n : n - 1;
    for (let i = 0; i < last; i++) {
      const p0 = ctrl[(i - 1 + n) % n], p1 = ctrl[i % n];
      const p2 = ctrl[(i + 1) % n], p3 = ctrl[(i + 2) % n];
      /* 開放路徑的端點沒有前後鄰居，用自己頂替，曲線才不會往外甩 */
      const a = closed ? p0 : ctrl[Math.max(0, i - 1)];
      const d = closed ? p3 : ctrl[Math.min(n - 1, i + 2)];
      for (let s = 0; s < 24; s++) {
        const t = s / 24;
        dense.push([
          catmull(a[0], p1[0], p2[0], d[0], t),
          catmull(a[1], p1[1], p2[1], d[1], t),
          catmull(a[2], p1[2], p2[2], d[2], t)
        ]);
      }
    }
    if (!closed) dense.push(ctrl[n - 1].slice());

    let nodes = resample(dense, closed);
    /* 控制點被切角之後，Catmull-Rom 在角上會擠出半徑只有十幾單位的尖角：
     * 中心線一折，畫出來的路面就是一片一片歪掉的鋸齒。先把中心線的曲率壓下來，
     * 之後畫路面、鋪地表格、AI 走線用的都是同一條順的線。 */
    nodes = smoothCurve(nodes, closed);
    return resample(nodes.map(nd => [nd.x, nd.y, nd.w]), closed);
  }

  /** 依距離重新取樣成等間距節點，進度計算才準 */
  function resample(dense, closed) {
    const nodes = [];
    let carry = 0;
    for (let i = 0; i < dense.length - 1; i++) {
      const a = dense[i], b = dense[i + 1];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const seg = Math.sqrt(dx * dx + dy * dy);
      if (seg < 1e-6) continue;
      let t = carry;
      while (t < seg) {
        const k = t / seg;
        nodes.push({ x: a[0] + dx * k, y: a[1] + dy * k, w: a[2] + (b[2] - a[2]) * k });
        t += NODE_STEP;
      }
      carry = t - seg;
    }
    if (closed && dense.length > 2) {
      /* 閉環最後一段要接回起點 */
      const a = dense[dense.length - 1], b = dense[0];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const seg = Math.sqrt(dx * dx + dy * dy);
      let t = carry;
      while (t < seg) {
        const k = t / seg;
        nodes.push({ x: a[0] + dx * k, y: a[1] + dy * k, w: a[2] + (b[2] - a[2]) * k });
        t += NODE_STEP;
      }
    }
    /* 閉環時，如果最後一個節點離起點太近就砍掉，避免重複 */
    if (closed && nodes.length > 2) {
      const f = nodes[0], l = nodes[nodes.length - 1];
      if (Math.hypot(l.x - f.x, l.y - f.y) < NODE_STEP * 0.5) nodes.pop();
    }
    return nodes;
  }

  /* 中心線平滑：把等間距節點跟一個高斯核做一次卷積。
   *
   * 控制點被切角之後，Catmull-Rom 會在角上擠出半徑只有十幾單位的尖角；
   * 中心線一折，路面畫出來就是一片一片歪掉的鋸齒（「賽道線鋸齒狀」就是這個）。
   * 高斯把波長比 SMOOTH_SIGMA 短的東西整個抹掉，尖角一定會變成圓弧，
   * 直線完全不受影響，大彎只會往內縮 σ²/2R（幾十單位的彎大概 3%），
   * 所以賽道的形狀、長度、難度都還是原來那樣。
   * 一次算完，不用迭代，每張賽道的結果也都是固定的。 */
  const SMOOTH_SIGMA = 42;        /* 高斯的標準差（單位）；也大致是磨出來的最小轉彎半徑 */

  function polyLength(nodes, closed) {
    let L = 0;
    for (let i = 0; i + 1 < nodes.length; i++) L += Math.hypot(nodes[i + 1].x - nodes[i].x, nodes[i + 1].y - nodes[i].y);
    if (closed && nodes.length > 1) L += Math.hypot(nodes[0].x - nodes[nodes.length - 1].x, nodes[0].y - nodes[nodes.length - 1].y);
    return L;
  }

  function smoothCurve(nodes, closed) {
    /* 抹得太兇的話，來回折的兩段路有機會被平均在一起、整個塌掉。
     * 長度掉超過一成就換小一點的 σ 再來一次，形狀一定保得住。 */
    const before = polyLength(nodes, closed);
    for (let sigma = SMOOTH_SIGMA; sigma >= SMOOTH_SIGMA / 4; sigma /= 2) {
      const out = blurCurve(nodes, closed, sigma);
      if (out === nodes || polyLength(out, closed) >= before * 0.9) return out;
    }
    return nodes;
  }

  function blurCurve(nodes, closed, sigma) {
    const n = nodes.length;
    const sig = sigma / NODE_STEP;
    const half = Math.ceil(sig * 3);
    if (n < half * 2 + 4) return nodes;
    const kern = [];
    let sum = 0;
    for (let j = -half; j <= half; j++) { const v = Math.exp(-(j * j) / (2 * sig * sig)); kern.push(v); sum += v; }
    for (let i = 0; i < kern.length; i++) kern[i] /= sum;
    const wrap = i => (closed ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i)));
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      /* 開放賽道的頭尾要釘住，不然起點終點會被magnet往內拉 */
      let x = 0, y = 0, w = 0;
      for (let j = -half; j <= half; j++) {
        const nd = nodes[wrap(i + j)], k = kern[j + half];
        x += nd.x * k; y += nd.y * k; w += nd.w * k;
      }
      if (!closed) {
        /* 端點附近逐漸回到原位，頭尾才不會被往內拉 */
        const edge = Math.min(i, n - 1 - i) / half;
        const t = Math.min(1, Math.max(0, edge));
        const nd = nodes[i];
        x = nd.x + (x - nd.x) * t; y = nd.y + (y - nd.y) * t; w = nd.w + (w - nd.w) * t;
      }
      out[i] = { x: x, y: y, w: w };
    }
    return out;
  }

  /** 幫每個節點算出切線方向與法線（畫邊線、擺道具、AI 走線都要用） */
  function addTangents(nodes, closed) {
    const n = nodes.length;
    for (let i = 0; i < n; i++) {
      const a = closed ? nodes[(i - 1 + n) % n] : nodes[Math.max(0, i - 1)];
      const b = closed ? nodes[(i + 1) % n] : nodes[Math.min(n - 1, i + 1)];
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      nodes[i].tx = dx / len;
      nodes[i].ty = dy / len;
      nodes[i].nx = -nodes[i].ty;   /* 法線指向左手邊 */
      nodes[i].ny = nodes[i].tx;
    }
    return nodes;
  }

  function angleDiff(a, b) {
    let d = a - b;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return d;
  }

  /**
   * 找一段起點前後都比較直的節點，避免第一幀鏡頭直接落在彎道裡。
   * 前方權重較高，因為玩家開局看到的是起跑線後面的路。
   */
  function chooseStartNode(nodes, open, requested) {
    if (open || nodes.length < START_STRAIGHT_NODES * 2 + 1) return 0;
    const n = nodes.length;
    const preferred = ((Number.isFinite(requested) ? requested : 0) % n + n) % n;
    const span = Math.min(START_STRAIGHT_NODES, Math.floor((n - 1) / 2));
    const scoreAt = index => {
      const base = Math.atan2(nodes[index].ty, nodes[index].tx);
      let forwardMax = 0, backwardMax = 0, forwardSum = 0, backwardSum = 0;
      for (let d = 1; d <= span; d++) {
        const ahead = (index + d) % n;
        const behind = (index - d + n) % n;
        const f = Math.abs(angleDiff(Math.atan2(nodes[ahead].ty, nodes[ahead].tx), base));
        const b = Math.abs(angleDiff(Math.atan2(nodes[behind].ty, nodes[behind].tx), base));
        forwardMax = Math.max(forwardMax, f);
        backwardMax = Math.max(backwardMax, b);
        forwardSum += f;
        backwardSum += b;
      }
      return forwardMax * 2 + forwardSum * 0.2 + backwardMax + backwardSum * 0.1;
    };

    let best = preferred;
    let bestScore = scoreAt(best);
    for (let i = 0; i < n; i++) {
      const score = scoreAt(i);
      const distance = Math.min(Math.abs(i - preferred), n - Math.abs(i - preferred));
      const bestDistance = Math.min(Math.abs(best - preferred), n - Math.abs(best - preferred));
      if (score < bestScore - 1e-6 || (Math.abs(score - bestScore) <= 1e-6 && distance < bestDistance)) {
        best = i;
        bestScore = score;
      }
    }
    return best;
  }

  /* ---------- 地形網格 ---------- */

  function makeGrid(bounds) {
    const cols = Math.ceil((bounds.maxX - bounds.minX) / CELL) + 2;
    const rows = Math.ceil((bounds.maxY - bounds.minY) / CELL) + 2;
    return {
      cols, rows,
      x0: bounds.minX - CELL, y0: bounds.minY - CELL,
      surface: new Uint8Array(cols * rows),
      /* 每格記「最近的節點 index」，查進度就不必掃全部節點 */
      node: new Int16Array(cols * rows).fill(-1)
    };
  }

  function cellOf(grid, x, y) {
    const cx = Math.floor((x - grid.x0) / CELL);
    const cy = Math.floor((y - grid.y0) / CELL);
    if (cx < 0 || cy < 0 || cx >= grid.cols || cy >= grid.rows) return -1;
    return cy * grid.cols + cx;
  }

  /** 把一條帶狀路徑（節點 ＋ 半寬）燒進網格 */
  function paintRibbon(grid, nodes, surface, writeNodeIndex) {
    for (let i = 0; i < nodes.length; i++) {
      const nd = nodes[i];
      const w = nd.w;
      const steps = Math.ceil(w / CELL) + 1;
      for (let s = -steps; s <= steps; s++) {
        const off = (s / steps) * w;
        const px = nd.x + nd.nx * off;
        const py = nd.y + nd.ny * off;
        /* 沿法線塗一條線；節點間隔 14 比格子 12 大一點，所以順便塗一點切線方向 */
        for (let t = -1; t <= 1; t++) {
          const c = cellOf(grid, px + nd.tx * t * CELL * 0.5, py + nd.ty * t * CELL * 0.5);
          if (c < 0) continue;
          grid.surface[c] = surface;
          if (writeNodeIndex && grid.node[c] < 0) grid.node[c] = i;
        }
      }
    }
  }

  function paintBlob(grid, x, y, r, surface) {
    const steps = Math.ceil(r / CELL) + 1;
    for (let iy = -steps; iy <= steps; iy++) {
      for (let ix = -steps; ix <= steps; ix++) {
        const px = x + ix * CELL, py = y + iy * CELL;
        if (Math.hypot(px - x, py - y) > r) continue;
        const c = cellOf(grid, px, py);
        /* 只在跑道上塗，泥巴／加速帶不會長到草地上 */
        if (c >= 0 && grid.surface[c] === SURFACE.TRACK) grid.surface[c] = surface;
      }
    }
  }

  /* ---------- 組裝一張賽道 ---------- */

  /**
   * @param {object} def 賽道定義（TRACKS 裡的一筆，或 randomDef 產出的）
   * @returns {object} 可以直接餵給 rules.js 的賽道
   */
  /* 路面加寬倍率。
   * 追尾視角下，原本的寬度在畫面上只佔中間細細一條，兩邊都是草地；
   * 參考畫面裡的路是鋪滿整個下半部的。寬度是在這裡一次放大的，
   * 每張賽道的 ctrl 都不用改；石頭會在下面自動往外推，不會被路吞掉。 */
  const ROAD_WIDE = [2.2, 2.05, 1.9, 1.75, 1.6, 1.45, 1.3, 1.18, 1.08, 1.0];   /* 想要的加寬倍率，由寬到窄 */
  const ROAD_MIN_FLOORS = [142, 130, 118, 106, 0];   /* 想要的最小寬度，由寬到窄 */

  /**
   * 盡量加寬，但不能寬到自己貼到自己。
   *
   * 賽道繞回來從旁邊經過的地方（菜園迷宮、荷花池塘都有），
   * 兩條路面一旦黏在一起，格子的節點索引就會對到錯的那一條，
   * 計圈跟進度全部跟著壞掉 —— 就是之前那個「還沒到終點就完賽」的同一類問題。
   * 所以由寬到窄試一輪，挑第一個不會黏住的倍率。
   */
  function fitWiden(nodes) {
    const base = nodes.map(nd => nd.w);
    for (const k of ROAD_WIDE) {
      /* 最小寬度也由寬到窄試一輪：很窄的賽道套不上最寬的那個門檻，
       * 但套得上次一級的，總比直接掉回原寬好。
       * 回傳的是「倍率 ＋ 當時用的門檻」，捷徑才能套一樣的規格。 */
      for (const floor of ROAD_MIN_FLOORS) {
        for (let i = 0; i < nodes.length; i++) nodes[i].w = Math.max(base[i] * k, floor);
        if (!selfOverlaps(nodes)) return { k: k, floor: floor };
      }
    }
    for (let i = 0; i < nodes.length; i++) nodes[i].w = base[i];
    return { k: 1, floor: 0 };
  }

  function widenBy(nodes, fit) {
    for (const nd of nodes) nd.w = Math.max(nd.w * fit.k, fit.floor);
    return nodes;
  }

  /**
   * 路變寬之後，原本擦邊的石頭會落到路面上，要推出去。
   *
   * 只沿最近節點的法線推一次是不夠的：賽道繞回來的地方，推出 A 段的路面
   * 有可能正好推進 B 段。所以推完再用格子實際驗一次，不行就加大距離、
   * 換一邊、最後真的清不掉就把那顆石頭丟掉 —— 石頭是裝飾兼障礙，
   * 少一顆沒差，卡在路中間才是問題。
   */
  function placeRocks(rocks, nodes, grid) {
    const n = nodes.length;
    const out = [];
    const clear = (x, y, r) => {
      /* 檢查整個圓盤涵蓋的網格，避免連續彎從斜角切進石頭。 */
      const minCol = Math.max(0, Math.floor((x - r - grid.x0) / CELL));
      const maxCol = Math.min(grid.cols - 1, Math.floor((x + r - grid.x0) / CELL));
      const minRow = Math.max(0, Math.floor((y - r - grid.y0) / CELL));
      const maxRow = Math.min(grid.rows - 1, Math.floor((y + r - grid.y0) / CELL));
      for (let row = minRow; row <= maxRow; row++) {
        for (let col = minCol; col <= maxCol; col++) {
          const left = grid.x0 + col * CELL, top = grid.y0 + row * CELL;
          const dx = x - Math.max(left, Math.min(x, left + CELL));
          const dy = y - Math.max(top, Math.min(y, top + CELL));
          if (dx * dx + dy * dy <= r * r && grid.surface[row * grid.cols + col] !== SURFACE.GRASS) return false;
        }
      }
      return true;
    };
    for (const rk of rocks) {
      if (clear(rk[0], rk[1], rk[2])) { out.push(rk); continue; }
      let best = -1, bestD = Infinity;
      for (let i = 0; i < n; i++) {
        const dx = nodes[i].x - rk[0], dy = nodes[i].y - rk[1];
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = i; }
      }
      if (best < 0) continue;
      const nd = nodes[best];
      const along = (rk[0] - nd.x) * nd.tx + (rk[1] - nd.y) * nd.ty;
      const lat = (rk[0] - nd.x) * nd.nx + (rk[1] - nd.y) * nd.ny;
      let placed = null;
      for (const side of (lat >= 0 ? [1, -1] : [-1, 1])) {
        for (let extra = 0; extra <= 180 && !placed; extra += 30) {
          const off = side * (nd.w + rk[2] + 18 + extra);
          const x = nd.x + nd.tx * along + nd.nx * off;
          const y = nd.y + nd.ty * along + nd.ny * off;
          if (clear(x, y, rk[2])) placed = [x, y, rk[2]];
        }
        if (placed) break;
      }
      if (placed) out.push(placed);
    }
    return out;
  }

  function build(def) {
    const open = !!def.open;          /* 衝刺賽道：起點到終點，不繞圈 */
    let ctrl = def.ctrl;
    let nodes = addTangents(sample(ctrl, !open), !open);
    let wideK = fitWiden(nodes);
    /* 有些賽道（菜園迷宮、夜光蘑菇）自己繞回來的地方本來就很擠，
     * 路面根本加不寬。那就把整張圖等比例放大 —— 形狀一模一樣，
     * 只是彎跟彎之間空出距離，路面才寬得起來。 */
    const avgW = () => nodes.reduce((a, nd) => a + nd.w, 0) / nodes.length;
    if (wideK.k < 1.35 || avgW() < 112) {
      const GROW = 1.32;
      ctrl = ctrl.map(p => [p[0] * GROW, p[1] * GROW, p[2]]);
      nodes = addTangents(sample(ctrl, !open), !open);
      wideK = fitWiden(nodes);
    }
    const scaled = ctrl !== def.ctrl;
    const grow = scaled ? 1.32 : 1;
    const shortcuts = (def.shortcuts || []).map(sc => ({
      nodes: widenBy(addTangents(sample(
        grow === 1 ? sc.ctrl : sc.ctrl.map(p => [p[0] * grow, p[1] * grow, p[2]]), false), false), wideK),
      /* 捷徑接回主賽道的節點 index，用來讓進度計算不會倒退 */
      from: sc.from, to: sc.to
    }));

    /* 世界範圍：所有節點外擴一段草地 */
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const all = nodes.concat(...shortcuts.map(s => s.nodes));
    for (const nd of all) {
      minX = Math.min(minX, nd.x - nd.w); maxX = Math.max(maxX, nd.x + nd.w);
      minY = Math.min(minY, nd.y - nd.w); maxY = Math.max(maxY, nd.y + nd.w);
    }
    const PAD = 130;
    const bounds = { minX: minX - PAD, minY: minY - PAD, maxX: maxX + PAD, maxY: maxY + PAD };

    const grid = makeGrid(bounds);
    paintRibbon(grid, nodes, SURFACE.TRACK, true);
    for (const sc of shortcuts) paintRibbon(grid, sc.nodes, SURFACE.TRACK, false);
    const mudList = (def.mud || []).map(m => [m[0] * grow, m[1] * grow, m[2]]);
    const boostList = (def.boosts || []).map(b => [b[0] * grow, b[1] * grow, b[2]]);
    for (const m of mudList) paintBlob(grid, m[0], m[1], m[2], SURFACE.MUD);
    for (const b of boostList) paintBlob(grid, b[0], b[1], b[2], SURFACE.BOOST);

    /* 捷徑格子的節點 index：借用它接回主賽道的區間，進度才不會因為抄捷徑爆掉 */
    for (const sc of shortcuts) {
      for (let i = 0; i < sc.nodes.length; i++) {
        const k = i / Math.max(1, sc.nodes.length - 1);
        const idx = Math.round(sc.from + (sc.to - sc.from) * k);
        const nd = sc.nodes[i];
        const steps = Math.ceil(nd.w / CELL) + 1;
        for (let s = -steps; s <= steps; s++) {
          const off = (s / steps) * nd.w;
          const c = cellOf(grid, nd.x + nd.nx * off, nd.y + nd.ny * off);
          if (c >= 0 && grid.node[c] < 0) grid.node[c] = ((idx % nodes.length) + nodes.length) % nodes.length;
        }
      }
    }

    /* 道具葉：沿賽道等距擺，左右交錯，用 seed 決定橫向偏移 */
    const rng = RNG.create(def.seed || def.id || 'track');
    const items = [];
    /* 道具葉：排數與每排的數量都收斂過。
     * 原本一排最多三片、排得又密，整條路面看過去都是葉子，賽道本身反而看不清楚。 */
    const gap = Math.max(11, Math.floor(nodes.length / (def.itemCount || 12)));
    for (let i = Math.floor(gap / 2); i < nodes.length; i += gap) {
      const nd = nodes[i];
      const lanes = rng.int(1, 2);
      for (let k = 0; k < lanes; k++) {
        const off = (k - (lanes - 1) / 2) * (nd.w * 0.55);
        items.push({ x: nd.x + nd.nx * off, y: nd.y + nd.ny * off, node: i });
      }
    }

    /* 起跑格：八個選手在同一條線上並排，起點挑在一段較直的路上。 */
    const startNode = chooseStartNode(nodes, open, def.startNode);
    const grid0 = nodes[startNode];
    const starts = [];
    const laneGap = Math.min(START_LANE_GAP, Math.max(START_LANE_GAP - 2, grid0.w * 0.24));
    const laneCenter = (8 - 1) / 2;
    for (let s = 0; s < 8; s++) {
      const side = (s - laneCenter) * laneGap;
      starts.push({
        x: grid0.x + grid0.nx * side,
        y: grid0.y + grid0.ny * side,
        angle: Math.atan2(grid0.ty, grid0.tx),
        node: startNode
      });
    }

    return {
      id: def.id,
      name: def.name,
      desc: def.desc || '',
      theme: def.theme || def.id,
      stars: def.stars || 1,
      laps: def.laps || 3,
      random: !!def.random,
      seed: def.seed || def.id,
      nodes, shortcuts, grid, bounds, items, starts, startNode,
      rocks: placeRocks((def.rocks || []).map(r => [r[0] * grow, r[1] * grow, r[2]]), nodes, grid)
        .map(r => ({ x: r[0], y: r[1], r: r[2] })),
      mud: mudList.map(r => ({ x: r[0], y: r[1], r: r[2] })),
      boosts: boostList.map(r => ({ x: r[0], y: r[1], r: r[2] })),
      checkpoints: CHECKPOINTS,
      open: open,
      length: nodes.length * NODE_STEP
    };
  }

  /* ---------- 查詢 ---------- */

  /** 這個位置是什麼地形 */
  function surfaceAt(track, x, y) {
    const c = cellOf(track.grid, x, y);
    if (c < 0) return SURFACE.GRASS;
    return track.grid.surface[c];
  }

  /**
   * 這個位置對應賽道的哪個節點。
   *
   * 一開始是查網格（O(1)），但網格的 node 是「先搶先贏」——
   * 起終點接縫與髮夾彎的格子會被比較早的節點先佔走，
   * 結果毛毛蟲明明在第 280 個節點，網格卻回報第 5 個，檢查點順序就斷了，
   * 圈數永遠算不上去（夜光蘑菇那張跑三圈只算一圈）。
   *
   * 所以進度一律改用「從上次位置往前後找最近的」。窗口刻意做成前多後少：
   * 往前 45（最快也才 1.2 個節點／tick，夠用）、往後 12（允許小幅倒退但不會跳到對面），
   * 這樣 index 是連續且單調的，抄捷徑時也會平順地推進。
   */
  function nodeAt(track, x, y, lastIndex) {
    const nodes = track.nodes, n = nodes.length;
    const base = (lastIndex >= 0 ? lastIndex : 0);
    let best = base, bestD = Infinity;
    for (let d = -12; d <= 45; d++) {
      const i = track.open
        ? Math.max(0, Math.min(n - 1, base + d))
        : ((base + d) % n + n) % n;
      const dx = nodes[i].x - x, dy = nodes[i].y - y;
      const dist = dx * dx + dy * dy;
      if (dist < bestD) { bestD = dist; best = i; }
    }
    return best;
  }

  /**
   * 節點索引的正規化。
   * 環狀賽道是繞回去，衝刺賽道（open）是夾在兩端 ——
   * 不夾住的話，快到終點時「往前看 30 個節點」會看到起跑線，
   * AI 會突然往回轉，畫面也會把起點那一段接在終點後面。
   */
  function idx(track, i) {
    const n = track.nodes.length;
    if (track.open) return i < 0 ? 0 : (i >= n ? n - 1 : i);
    return ((i % n) + n) % n;
  }

  /** 節點 index → 以起跑點為零點的檢查點 index */
  function checkpointOf(track, nodeIndex) {
    const n = track.nodes.length;
    const origin = track.open ? 0 : (track.startNode || 0);
    const relative = track.open
      ? Math.max(0, Math.min(n - 1, nodeIndex - origin))
      : ((nodeIndex - origin) % n + n) % n;
    return Math.floor(relative / n * CHECKPOINTS) % CHECKPOINTS;
  }

  /** 賽道中心線上離某點最近的橫向偏移（負＝左、正＝右），給 AI 與畫面用 */
  function lateralOf(track, nodeIndex, x, y) {
    const nd = track.nodes[nodeIndex];
    return (x - nd.x) * nd.nx + (y - nd.y) * nd.ny;
  }

  /* ---------- 六張手設賽道 ---------- */

  /* 控制點格式：[x, y, 半寬]。座標以 (0,0) 為場地中心，單位大約等於 1 個像素。 */

  const TRACKS = [
    {
      id: 'garden', name: '花園小徑', theme: 'garden', stars: 1, laps: 2,
      desc: '寬敞好跑的入門賽道，彎道多但每個都很開，適合第一次玩。',
      startNode: 0, itemCount: 9,
      ctrl: [
        [480, 319, 91], [398, 394, 89], [224, 386, 93], [148, 337, 95], [149, 319, 101],
        [73, 270, 84], [38, 268, 103], [-42, 310, 79], [-43, 328, 90], [-123, 370, 88],
        [-433, 355, 86], [-507, 274, 80], [-493, -35, 99], [-445, -110, 89], [-428, -110, 80],
        [-381, -169, 102], [-380, -192, 93], [-422, -255, 82], [-438, -256, 79], [-480, -316, 86],
        [-479, -339, 86], [-398, -394, 80], [83, -372, 103], [163, -414, 90], [164, -432, 101],
        [243, -474, 82], [273, -473, 89], [348, -423, 96], [347, -406, 102], [415, -356, 101],
        [441, -355, 90], [507, -274, 99], [498, -74, 82], [454, 2, 103], [438, 1, 83], [395, 56, 79],
        [394, 78, 94], [432, 137, 100], [448, 137, 101], [485, 217, 84]
      ],
      boosts: [[200, -514, 51], [532, 124, 54]],
      mud: [[372, 498, 44], [-109, 475, 54], [-670, 376, 41], [-517, -157, 51], [-410, -519, 47], [669, -430, 41]],
      rocks: [[292, 734, 32], [115, 528, 28], [-235, 324, 35], [-558, -334, 40], [-462, -497, 40], [-391, -347, 27], [-20, -720, 36], [630, -643, 25], [478, -235, 30]]
    },
    {
      id: 'veggie', name: '菜園迷宮', theme: 'veggie', stars: 2, laps: 2,
      desc: '菜畦之間的直角彎一個接一個，這張最長，走線沒抓好就會撞牆。',
      startNode: 0, itemCount: 12,
      ctrl: [
        [-560, -420, 74], [-160, -440, 74], [-140, -140, 70], [-480, -120, 70],
        [-500, 180, 72], [-120, 200, 70], [-100, 470, 74], [300, 480, 76],
        [560, 300, 76], [540, -60, 74], [300, -180, 70], [320, -430, 74],
        [-80, -620, 78], [-520, -640, 78]
      ],
      boosts: [[-320, -430, 52], [430, 400, 54], [550, 120, 50]],
      mud: [[-300, 190, 46], [-130, 30, 44]],
      rocks: [[-266, -288, 70], [-296, 364, 66], [110, 130, 74], [493, -301, 58]]
    },
    {
      id: 'branch', name: '大樹枝幹', theme: 'branch', stars: 3, laps: 2,
      desc: '在樹枝上跑，路面很窄，掉下去就得在葉子上慢慢爬回來。',
      startNode: 0, itemCount: 10,
      ctrl: [
        [-30, -560, 58], [280, -480, 54], [470, -250, 50], [430, 60, 48],
        [560, 290, 52], [330, 470, 54], [10, 420, 50], [-260, 500, 52],
        [-500, 340, 50], [-440, 60, 48], [-560, -190, 52], [-360, -450, 56]
      ],
      shortcuts: [
        /* 樹枝之間的捷徑：很窄，但少繞一大圈 */
        { from: 26, to: 50, ctrl: [[470, -250, 32], [330, -60, 28], [330, 200, 28], [330, 470, 32]] }
      ],
      boosts: [[470, -130, 42], [-160, 440, 44], [-500, 150, 40]],
      mud: [[10, 420, 40], [-440, 60, 38]],
      rocks: [[0, -30, 190], [546, 513, 48], [-576, -443, 50]]
    },
    {
      id: 'pond', name: '水窪淺灘', theme: 'pond', stars: 2, laps: 2,
      desc: '雨後的淺灘，一路轉個不停，泥巴和水窪特別多，記得繞開深色的地方。',
      startNode: 0, itemCount: 12,
      ctrl: [
        [544, 388, 103], [463, 464, 87], [311, 460, 93], [231, 501, 102], [231, 517, 84],
        [169, 559, 83], [146, 559, 85], [87, 513, 95], [87, 497, 87], [51, 452, 88], [37, 452, 85],
        [0, 397, 82], [1, 377, 82], [-61, 322, 87], [-86, 321, 81], [-151, 373, 93], [-151, 393, 78],
        [-231, 444, 86], [-489, 436, 86], [-565, 356, 87], [-563, 270, 80], [-510, 193, 88],
        [-491, 194, 79], [-439, 117, 102], [-438, 73, 90], [-485, -7, 102], [-505, -7, 80],
        [-553, -49, 82], [-553, -64, 86], [-605, -106, 80], [-625, -107, 104], [-675, -186, 90],
        [-674, -229, 90], [-619, -306, 90], [-599, -305, 85], [-544, -372, 78], [-543, -398, 85],
        [-463, -464, 89], [-379, -462, 96], [-300, -500, 92], [-300, -515, 91], [-224, -553, 85],
        [-196, -553, 103], [-124, -510, 100], [-124, -495, 80], [-47, -452, 88], [79, -448, 82],
        [158, -494, 101], [158, -512, 82], [238, -557, 101], [271, -556, 95], [348, -506, 85],
        [347, -488, 82], [424, -438, 95], [489, -436, 80], [565, -356, 84], [559, -135, 87],
        [600, -56, 85], [617, -55, 83], [659, -1, 86], [659, 19, 79], [613, 71, 86], [597, 70, 80],
        [551, 147, 93]
      ],
      boosts: [[302, 461, 56], [-86, 321, 50], [44, -445, 49]],
      mud: [[-593, 376, 41], [-570, -75, 41], [-441, -471, 45], [510, -432, 49], [618, 52, 44]],
      rocks: [[733, 442, 36], [108, 278, 38], [-435, 268, 28], [-663, 54, 41], [457, 112, 36], [344, 231, 33]]
    },
    {
      id: 'candy', name: '糖果餅乾', theme: 'candy', stars: 3, laps: 2,
      desc: '餅乾鋪成的複雜路線，彎最多的一張，直線短但一個接一個，走線錯一次就慢一大截。',
      startNode: 0, itemCount: 10,
      ctrl: [
        [671, -46, 82], [657, 63, 99], [632, 83, 98], [546, 99, 89], [536, 87, 88], [463, 93, 80],
        [444, 107, 88], [421, 177, 78], [431, 189, 86], [435, 238, 82], [426, 244, 88],
        [435, 299, 100], [447, 314, 80], [424, 394, 80], [404, 410, 98], [321, 413, 87],
        [309, 398, 91], [233, 396, 82], [215, 409, 82], [143, 412, 79], [133, 399, 94],
        [56, 406, 81], [37, 421, 79], [12, 494, 92], [22, 507, 94], [-13, 588, 104], [-96, 653, 90],
        [-206, 640, 86], [-239, 597, 81], [-327, 566, 95], [-342, 578, 98], [-429, 547, 95],
        [-455, 514, 94], [-464, 422, 90], [-449, 410, 83], [-458, 318, 82], [-671, 46, 92],
        [-657, -63, 97], [-583, -122, 101], [-496, -138, 88], [-487, -126, 98], [-419, -128, 96],
        [-402, -141, 85], [-384, -206, 93], [-393, -219, 91], [-382, -279, 97], [-368, -290, 82],
        [-302, -279, 104], [-290, -264, 100], [-208, -265, 86], [-188, -280, 97], [-168, -359, 98],
        [-179, -374, 81], [-173, -443, 91], [-159, -454, 80], [-156, -527, 91], [-169, -543, 90],
        [-142, -636, 99], [-108, -662, 80], [-12, -667, 92], [1, -650, 91], [87, -646, 93],
        [106, -661, 103], [206, -640, 88], [255, -577, 83], [260, -482, 86], [244, -469, 103],
        [232, -395, 84], [245, -379, 90], [320, -372, 87], [336, -385, 82], [411, -377, 82],
        [424, -362, 94], [496, -352, 100], [511, -363, 81], [598, -334, 92], [616, -311, 82],
        [623, -219, 101], [608, -208, 91], [617, -115, 83]
      ],
      boosts: [[484, 90, 51], [199, 411, 53], [-224, 620, 50], [-529, 226, 60], [583, -340, 58]],
      mud: [[-424, -120, 43], [-130, -473, 53], [215, -583, 47]],
      rocks: [[625, 237, 41], [438, 615, 37], [66, 225, 27], [-892, -65, 33], [-281, -488, 30], [111, -424, 34], [786, -237, 41]]
    },
    {
      id: 'shroom', name: '夜光蘑菇', theme: 'shroom', stars: 4, laps: 2,
      desc: '夜裡的蘑菇森林，彎急、捷徑多，是最難的一張。',
      startNode: 0, itemCount: 13,
      ctrl: [
        [-60, -560, 56], [230, -520, 54], [340, -320, 50], [200, -140, 46],
        [420, -40, 50], [560, 170, 54], [360, 400, 54], [60, 430, 50],
        [-120, 300, 46], [-300, 460, 52], [-560, 330, 54], [-520, 60, 50],
        [-330, -80, 46], [-480, -280, 52], [-360, -520, 56]
      ],
      shortcuts: [
        { from: 10, to: 34, ctrl: [[230, -520, 26], [440, -400, 24], [500, -170, 24], [560, 170, 28]] },
        { from: 58, to: 80, ctrl: [[60, 430, 26], [-180, 470, 24], [-420, 430, 26], [-560, 330, 28]] }
      ],
      boosts: [[300, -420, 40], [480, 60, 42], [-560, 190, 40], [-420, -400, 38]],
      mud: [[200, -140, 38], [-120, 300, 38], [-330, -80, 36]],
      rocks: [[0, -20, 160], [-620, -560, 46], [620, 500, 46]]
    }
,
    {
      /* boxy  seed=boxy-2  長度 3920  路寬 122  一圈 16.2s  葉 17 */
      id: 'beach', name: '海灣大道', theme: 'beach', stars: 2, laps: 2,
      desc: '沙灘旁的環海大道，長直線接連續彎，最好練走線的一張。',
      startNode: 0, itemCount: 12,
      ctrl: [
        [271, -515, 81], [350, -439, 98], [354, -286, 102], [399, -209, 87], [416, -210, 81],
        [461, -133, 85], [462, -94, 86], [420, -15, 83], [404, -14, 91], [362, 19, 82],
        [362, 32, 93], [407, 63, 80], [424, 63, 98], [469, 119, 99], [470, 140, 101], [427, 199, 90],
        [410, 199, 93], [368, 278, 97], [371, 421, 96], [295, 501, 95], [165, 504, 93],
        [85, 458, 95], [85, 440, 103], [10, 394, 104], [-18, 394, 99], [-91, 444, 90],
        [-90, 463, 86], [-167, 512, 78], [-271, 515, 89], [-350, 439, 101], [-352, 392, 85],
        [-303, 312, 102], [-284, 312, 102], [-236, 233, 94], [-236, 203, 94], [-289, 126, 98],
        [-308, 127, 93], [-358, 107, 83], [-359, 99, 79], [-406, 79, 94], [-424, 79, 88],
        [-472, 7, 83], [-473, -21, 90], [-428, -95, 87], [-410, -95, 90], [-365, -174, 90],
        [-371, -421, 79], [-295, -501, 83], [-185, -504, 93], [-108, -549, 94], [-108, -566, 93],
        [-58, -611, 96], [-39, -612, 103], [14, -569, 89], [14, -552, 89], [93, -511, 81]
      ],
      boosts: [[465, -410, 51], [531, 80, 58], [-95, 567, 59], [-402, 415, 51]],
      mud: [[455, 606, 49], [-610, -1, 51], [-477, -577, 50], [39, -743, 47]],
      rocks: [[309, -468, 34], [283, -317, 40], [419, -163, 30], [768, 29, 25], [294, 883, 38], [-269, 922, 40], [-626, 320, 25], [-851, -95, 28], [-258, -330, 28], [11, -635, 38]]
    },
    {
      /* kidney  seed=kidney-10  長度 3262  路寬 112  一圈 14.3s  葉 20 */
      id: 'canyon', name: '岩石峽谷', theme: 'canyon', stars: 3, laps: 2,
      desc: '峽谷裡的髮夾連發，一個接一個往回折，收油的時機最重要。',
      startNode: 0, itemCount: 12,
      ctrl: [
        [554, 160, 85], [505, 233, 96], [286, 272, 87], [234, 335, 84], [238, 354, 89],
        [186, 417, 89], [156, 422, 88], [85, 382, 92], [82, 363, 104], [27, 320, 86], [9, 323, 79],
        [-46, 279, 104], [-49, 259, 95], [-120, 217, 86], [-175, 227, 100], [-226, 291, 94],
        [-222, 311, 82], [-274, 374, 82], [-390, 395, 88], [-462, 346, 84], [-478, 259, 89],
        [-443, 190, 88], [-425, 187, 99], [-390, 117, 98], [-397, 83, 96], [-454, 30, 87],
        [-472, 33, 91], [-529, -19, 95], [-554, -160, 96], [-505, -233, 86], [-351, -261, 79],
        [-299, -325, 84], [-303, -345, 95], [-252, -409, 83], [-189, -420, 80], [-118, -378, 80],
        [-115, -358, 90], [-44, -316, 99], [390, -395, 81], [462, -346, 81], [490, -193, 87],
        [446, -122, 98], [425, -118, 103], [381, -47, 98], [393, 19, 79], [459, 70, 83],
        [480, 66, 87], [546, 117, 93]
      ],
      boosts: [[469, 341, 58], [-556, 76, 54]],
      mud: [[17, 398, 43], [-443, 500, 48], [-527, -320, 52], [-87, -421, 40], [547, -532, 40], [534, -2, 48]],
      rocks: [[534, 154, 38], [124, 216, 31], [-485, 336, 30], [-29, -656, 41], [328, -698, 26], [579, 275, 38]]
    },
    {
      /* snake  seed=snake-6  長度 4088  路寬 126  一圈 20.2s  葉 17 */
      id: 'snow', name: '雪地蜿蜒', theme: 'snow', stars: 4, laps: 2,
      desc: '雪原上的連續左右彎，一個接一個，節奏抓不到就會一直滑出去。',
      startNode: 0, itemCount: 13,
      ctrl: [
        [-48, 599, 90], [-128, 564, 79], [-292, 136, 90], [-265, 59, 100], [-247, 52, 83],
        [-220, -25, 87], [-245, -91, 100], [-317, -130, 82], [-335, -123, 87], [-407, -162, 80],
        [-472, -333, 84], [-442, -412, 91], [-422, -419, 85], [-388, -489, 102], [-395, -508, 86],
        [-357, -580, 86], [-313, -596, 87], [-237, -569, 94], [-229, -550, 103], [-194, -507, 84],
        [-188, -509, 104], [-156, -475, 79], [-150, -459, 89], [-81, -440, 100], [-60, -447, 101],
        [-22, -508, 86], [-28, -524, 102], [14, -587, 97], [48, -599, 88], [128, -564, 103],
        [218, -329, 80], [292, -291, 94], [312, -299, 82], [385, -266, 79], [392, -246, 80],
        [360, -173, 83], [341, -166, 104], [311, -88, 83], [377, 85, 93], [449, 123, 92],
        [468, 116, 81], [537, 145, 102], [544, 163, 99], [512, 230, 96], [493, 237, 79],
        [464, 313, 102], [473, 335, 86], [437, 414, 81], [304, 464, 93], [232, 449, 86],
        [226, 435, 82], [160, 418, 92], [140, 425, 100], [102, 483, 104], [107, 497, 84],
        [64, 557, 85]
      ],
      boosts: [[-291, -43, 46], [-175, -598, 57], [235, -570, 56], [410, -117, 58]],
      mud: [[-247, 564, 41], [-593, -542, 47], [663, 357, 41], [196, 603, 50]],
      rocks: [[-281, -373, 32], [-839, -349, 35], [-691, -862, 32], [458, -589, 37], [321, -380, 37], [876, 312, 38], [109, 347, 33]]
    }
,
    {
      /* 衝刺賽道：open ＝ 起點到終點，沒有圈數。smooth  seed=smooth-0  長度 7532  節點 538  路寬 219  全程 39.6s  葉 17 */
      id: 'riverrun', name: '溪谷衝刺', theme: 'pond', stars: 2, laps: 1, open: true,
      desc: '從溪頭衝到溪尾，沒有圈數 —— 一條路跑到底，先到終點的贏。',
      startNode: 0, itemCount: 14,
      ctrl: [
        [-3223, -1156, 93], [-2955, -1291, 88], [-2661, -1351, 95], [-2361, -1343, 111],
        [-2069, -1411, 95], [-1797, -1284, 87], [-1561, -1099, 96], [-1362, -874, 96],
        [-1079, -775, 98], [-811, -641, 110], [-571, -461, 111], [-311, -311, 105], [-50, -163, 94],
        [145, 65, 101], [319, 309, 100], [610, 381, 107], [884, 504, 108], [1174, 426, 97],
        [1454, 532, 90], [1711, 688, 86], [1992, 791, 93], [2219, 987, 103], [2394, 1231, 110],
        [2637, 1407, 108], [2937, 1411, 105], [3223, 1321, 97]
      ],
      boosts: [[-2205, -1387, 60], [-1345, -864, 57], [1363, 486, 53], [2257, 1035, 50]],
      mud: [[-381, -427, 52], [341, 370, 51]],
      rocks: [[-917, -1004, 38], [-684, -133, 29], [238, -309, 35], [349, 644, 25], [1104, 764, 37], [1419, 806, 33], [1901, 1105, 27], [2688, 1099, 27]]
    },
    {
      /* 衝刺賽道：open ＝ 起點到終點，沒有圈數。zig  seed=zig-0  長度 6944  節點 496  路寬 217  全程 40.2s  葉 17 */
      id: 'dunedash', name: '沙丘飛車', theme: 'beach', stars: 3, laps: 1, open: true,
      desc: '沙丘之間的單程賽，連續彎一個接一個，走錯一個就追不回來。',
      startNode: 0, itemCount: 14,
      ctrl: [
        [-3259, -336, 89], [-2976, -434, 109], [-2687, -353, 99], [-2388, -380, 87],
        [-2103, -288, 108], [-1822, -182, 92], [-1523, -209, 98], [-1238, -116, 106],
        [-971, 21, 100], [-748, 221, 96], [-450, 186, 100], [-155, 243, 102], [145, 230, 94],
        [439, 174, 109], [737, 215, 91], [1037, 214, 98], [1307, 344, 94], [1593, 434, 112],
        [1861, 300, 95], [2158, 347, 109], [2457, 328, 92], [2726, 195, 87], [3018, 126, 102],
        [3259, 305, 86]
      ],
      boosts: [[-2314, -365, 53], [-1375, -172, 54], [1382, 376, 51]],
      mud: [[-512, 250, 45], [444, 195, 53], [2312, 361, 50]],
      rocks: [[-2782, -40, 35], [-1571, 60, 25], [-921, -313, 26], [-666, -88, 26], [-38, -44, 36], [488, 506, 30], [1242, -55, 41], [1515, 113, 33], [2601, -77, 33]]
    }
  ];

  const BY_ID = {};
  for (const t of TRACKS) BY_ID[t.id] = t;

  /* ---------- 隨機賽道 ---------- */

  /* ---------- 隨機賽道的五種版型 ----------
   *
   * 原本只有一種：極座標抖動的閉環 —— 所以每一張隨機賽道都是一個圓圓的環，
   * 跑起來全長得一樣。改成五個版型輪流抽，剪影就完全不同了：
   *
   *   blob     圓環抖動（原本那種，留著當保底）
   *   boxy     超橢圓：四條長直線 ＋ 四個角，像街道賽
   *   kidney   腰果：一側凹進去一個深彎，一邊大直線一邊髮夾
   *   peanut   啞鈴：兩個大圓弧中間收一個窄腰
   *   snake    蛇行長條：拉長的橢圓上疊正弦波，連續左右彎
   *
   * 五種都是「不自交的閉曲線」—— 計圈、格子索引、捷徑都建立在這個前提上，
   * 真的畫成 8 字會讓同一格對到兩個節點 index，圈數就毀了。
   */
  const SHAPES = ['circuit', 'circuit', 'circuit', 'hairpin', 'hairpin', 'snake', 'kidney', 'peanut', 'boxy', 'blob'];
  const SHAPE_NAME = {
    blob: '圓環', boxy: '街道', kidney: '腰果', peanut: '啞鈴', snake: '蛇行',
    circuit: '多彎賽道', hairpin: '髮夾連發'
  };

  /** 超橢圓的半徑：n 越大越方 */
  function superR(a, b, n, th) {
    const c = Math.abs(Math.cos(th)), s = Math.abs(Math.sin(th));
    return 1 / Math.pow(Math.pow(c / a, n) + Math.pow(s / b, n), 1 / n);
  }


  /* ---------- 多彎版型：從矩形長出凹凸，彎道一個接一個 ----------
   *
   * 前面那幾種都是「一個大圈」，剪影不同但跑起來都是繞一圈。
   * 真正的賽車場是：長直線 → 髮夾 → 連續彎 → 再一段直線。
   * 作法是拿一個矩形，沿著四條邊隨機長出方形的凹（往內）或凸（往外），
   * 每一個凹凸就是四個直角彎；最後把每個角切成兩點，
   * Catmull-Rom 一平滑就變成圓潤但確實會轉的彎。
   *
   * 凹凸只沿著自己那條邊長，深度也夾住不讓對邊碰到，
   * 所以出來的一定是不自交的簡單多邊形 —— 這是計圈與格子索引的前提。
   */

  /** 把多邊形的每個角切成兩個點（倒角），平滑後才會是圓角而不是尖角 */
  function chamfer(poly, radius) {
    const n = poly.length, out = [];
    for (let i = 0; i < n; i++) {
      const p = poly[i], a = poly[(i - 1 + n) % n], b = poly[(i + 1) % n];
      const d1 = Math.hypot(p[0] - a[0], p[1] - a[1]) || 1;
      const d2 = Math.hypot(b[0] - p[0], b[1] - p[1]) || 1;
      const r1 = Math.min(radius, d1 * 0.42), r2 = Math.min(radius, d2 * 0.42);
      out.push([p[0] + (a[0] - p[0]) / d1 * r1, p[1] + (a[1] - p[1]) / d1 * r1]);
      out.push([p[0] + (b[0] - p[0]) / d2 * r2, p[1] + (b[1] - p[1]) / d2 * r2]);
    }
    return out;
  }

  /**
   * 沿一條邊長出凹凸。
   * @param from,to 這條邊的兩端（順時針）
   * @param inward  往內是哪個方向的單位向量
   * @param maxDepth 最深能凸多少
   */
  function bumpySide(from, to, inward, maxDepth, rng) {
    const len = Math.hypot(to[0] - from[0], to[1] - from[1]);
    const ux = (to[0] - from[0]) / len, uy = (to[1] - from[1]) / len;
    const pts = [];
    const margin = Math.max(90, len * 0.13);      /* 離兩端的角要留距離 */
    const usable = len - margin * 2;
    const count = usable < 200 ? 0 : rng.int(1, usable > 520 ? 3 : 2);
    let cursor = margin;
    for (let k = 0; k < count; k++) {
      const left = len - margin - cursor;
      const slots = count - k;
      const w = Math.min(left / slots - 50, rng.range(120, 210));
      if (w < 95) break;
      const gap = rng.range(40, Math.max(50, left / slots - w));
      const a = cursor + gap;
      const bEnd = a + w;
      if (bEnd > len - margin) break;
      const dir = rng.chance(0.55) ? 1 : -1;        /* 1＝往內凹，-1＝往外凸 */
      const depth = rng.range(95, Math.max(120, maxDepth)) * dir;
      pts.push([from[0] + ux * a, from[1] + uy * a]);
      pts.push([from[0] + ux * a + inward[0] * depth, from[1] + uy * a + inward[1] * depth]);
      pts.push([from[0] + ux * bEnd + inward[0] * depth, from[1] + uy * bEnd + inward[1] * depth]);
      pts.push([from[0] + ux * bEnd, from[1] + uy * bEnd]);
      cursor = bEnd;
    }
    return pts;
  }

  /** circuit：矩形 ＋ 四條邊的凹凸；hairpin：細長矩形，凹得更深＝髮夾 */
  function circuitCtrl(shape, rng) {
    const deep = shape === 'hairpin';
    /* 注意這是「半邊長」：實際矩形是 2W × 2H */
    const W = deep ? rng.range(500, 610) : rng.range(450, 560);
    const H = deep ? rng.range(270, 350) : rng.range(360, 460);
    const maxD = Math.min(W, H) * (deep ? 0.42 : 0.3);
    const c = [[-W, -H], [W, -H], [W, H], [-W, H]];      /* 順時針 */
    const inward = [[0, 1], [-1, 0], [0, -1], [1, 0]];
    const poly = [];
    for (let i = 0; i < 4; i++) {
      poly.push(c[i]);
      poly.push.apply(poly, bumpySide(c[i], c[(i + 1) % 4], inward[i], maxD, rng));
    }
    if (poly.length < 12) return null;                    /* 一個凹凸都沒長就不算多彎 */
    const rounded = chamfer(poly, deep ? 62 : 78);
    const rot = rng.range(0, Math.PI * 2);
    const cos = Math.cos(rot), sin = Math.sin(rot);
    const w = () => rng.range(78, 104);
    return rounded.map(p => [p[0] * cos - p[1] * sin, p[0] * sin + p[1] * cos, w()]);
  }

  /** 產生某個版型的控制點（回傳 [[x, y, w], ...]，閉合） */
  function shapeCtrl(shape, rng) {
    if (shape === 'circuit' || shape === 'hairpin') return circuitCtrl(shape, rng);
    const pts = [];
    const rot = rng.range(0, Math.PI * 2);
    const flip = rng.chance(0.5) ? 1 : -1;
    const W = () => rng.range(78, 108);

    if (shape === 'boxy') {
      const n = rng.int(16, 20);
      const a = rng.range(520, 700), b = a * rng.range(0.52, 0.82);
      const pow = rng.range(3.2, 5.0);
      for (let i = 0; i < n; i++) {
        const th = (i / n) * Math.PI * 2;
        const r = superR(a, b, pow, th);
        pts.push([Math.cos(th + rot) * r, Math.sin(th + rot) * r * flip, W()]);
      }
      return pts;
    }

    if (shape === 'kidney') {
      const n = rng.int(16, 20);
      const base = rng.range(480, 600);
      const dentAt = rng.range(0, Math.PI * 2);
      const depth = rng.range(0.38, 0.52);
      for (let i = 0; i < n; i++) {
        const th = (i / n) * Math.PI * 2;
        let d = th - dentAt;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        /* 高斯凹陷：只吃掉一小段角度，其餘維持大半徑 */
        const r = base * (1 - depth * Math.exp(-(d * d) / 0.34));
        pts.push([Math.cos(th + rot) * r, Math.sin(th + rot) * r * 0.86 * flip, W()]);
      }
      return pts;
    }

    if (shape === 'peanut') {
      const n = rng.int(18, 22);
      const a = rng.range(430, 540);
      const waist = rng.range(0.46, 0.58);
      for (let i = 0; i < n; i++) {
        const th = (i / n) * Math.PI * 2;
        const c = Math.cos(th);
        const r = a * (waist + (1.24 - waist) * c * c);
        pts.push([Math.cos(th + rot) * r, Math.sin(th + rot) * r * 0.9 * flip, W()]);
      }
      return pts;
    }

    if (shape === 'snake') {
      const n = rng.int(20, 24);
      const a = rng.range(640, 820), b = a * rng.range(0.34, 0.46);
      const waves = rng.int(3, 5);
      const amp = rng.range(0.13, 0.2);
      for (let i = 0; i < n; i++) {
        const th = (i / n) * Math.PI * 2;
        const k = 1 + amp * Math.sin(th * waves);
        pts.push([
          Math.cos(th + rot) * a * k,
          Math.sin(th + rot) * b * k * flip,
          W()
        ]);
      }
      return pts;
    }

    /* blob：原本那套極座標抖動 */
    const n = rng.int(9, 12);
    const baseR = rng.range(430, 560);
    const radii = [];
    for (let i = 0; i < n; i++) radii.push(baseR * rng.range(0.72, 1.3));
    /* 相鄰半徑差太大會出現尖角，壓平一輪 */
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < n; i++) {
        const p = radii[(i - 1 + n) % n], q = radii[(i + 1) % n];
        radii[i] = radii[i] * 0.6 + (p + q) * 0.2;
      }
    }
    for (let i = 0; i < n; i++) {
      const th = rot + (i / n) * Math.PI * 2;
      pts.push([Math.cos(th) * radii[i], Math.sin(th) * radii[i] * 0.86, W()]);
    }
    return pts;
  }

  /**
   * 這條閉曲線會不會自己撞到自己。
   * 只要有兩個「不相鄰」的節點靠得比兩邊路寬加起來還近，鋪成路面之後就會黏在一起，
   * 格子索引與計圈都會跟著壞掉，所以整張直接作廢重抽。
   */
  function selfOverlaps(nodes) {
    const n = nodes.length;
    /* 相鄰的節點本來就靠在一起，要跳過一段才算數。
     * 注意是「環上的距離」：第 1 個跟最後一個也是鄰居。 */
    const skip = Math.max(8, Math.round(n * 0.09));
    for (let i = 0; i < n; i++) {
      for (let j = i + skip; j < n; j++) {
        if (n - (j - i) < skip) continue;      /* 從另一邊繞回去也還是鄰居 */
        const a = nodes[i], b = nodes[j];
        const need = (a.w + b.w) * 1.05;
        const dx = a.x - b.x, dy = a.y - b.y;
        if (dx * dx + dy * dy < need * need) return true;
      }
    }
    return false;
  }

  /** 一張隨機賽道的候選：算出節點，順便把加速帶、泥巴、石頭擺在對的地方 */
  function tryShape(shape, rng) {
    const ctrl = shapeCtrl(shape, rng);
    if (!ctrl || ctrl.length < 6) return null;
    const nodes = addTangents(sample(ctrl, true), true);
    if (nodes.length < 130 || nodes.length > 440) return null;
    if (selfOverlaps(nodes)) return null;

    /* 地形全部從節點算：站在路中央的一定在路上，往側邊推出去的一定在路外。
     * 舊版把石頭寫死在原點，那是「一定是圓環」才成立的假設 ——
     * 腰果跟啞鈴的中心點根本就在跑道上。 */
    const boosts = [], mud = [], rocks = [];
    const step = Math.max(14, Math.floor(nodes.length / 11));
    for (let i = Math.floor(step / 2); i < nodes.length; i += step) {
      const nd = nodes[i];
      if (rng.chance(0.45)) boosts.push([nd.x, nd.y, rng.range(40, 58)]);
      else if (rng.chance(0.5)) {
        const off = nd.w * rng.range(-0.3, 0.3);
        mud.push([nd.x + nd.nx * off, nd.y + nd.ny * off, rng.range(36, 52)]);
      }
    }
    const rstep = Math.max(9, Math.floor(nodes.length / 16));
    for (let i = 0; i < nodes.length; i += rstep) {
      if (!rng.chance(0.55)) continue;
      const nd = nodes[i];
      const side = rng.chance(0.5) ? 1 : -1;
      const off = side * (nd.w + rng.range(38, 96));
      rocks.push([nd.x + nd.nx * off, nd.y + nd.ny * off, rng.range(22, 40)]);
    }
    if (!boosts.length) {
      const nd = nodes[Math.floor(nodes.length / 3)];
      boosts.push([nd.x, nd.y, 48]);
    }
    return { ctrl, boosts, mud, rocks, len: nodes.length * NODE_STEP };
  }

  /**
   * 隨機賽道：五種版型輪流抽，抽到的形狀算不出合格的曲線就換一種再試，
   * 真的都失敗才退回 blob（那一種幾乎不可能失敗）。
   */
  function randomDef(seed) {
    const rng = RNG.create(seed);
    /* 大部分的隨機賽道要是「彎很多」的那種 —— 只有圓環系的話，
     * 每一局跑起來都一樣。四分之三的 seed 先試多彎版型，
     * 剩下四分之一才讓圓環系優先，保留一點變化。 */
    const curvy = ['circuit', 'hairpin'];
    const rest = SHAPES.filter(x => curvy.indexOf(x) < 0);
    for (let i = rest.length - 1; i > 0; i--) {
      const j = rng.int(0, i);
      const t = rest[i]; rest[i] = rest[j]; rest[j] = t;
    }
    if (rng.chance(0.5)) { const t = curvy[0]; curvy[0] = curvy[1]; curvy[1] = t; }
    const order = rng.chance(0.75) ? curvy.concat(rest) : rest.concat(curvy);

    let got = null, shape = 'blob';
    const tried = {};
    for (const sh of order) {
      if (tried[sh]) continue;
      tried[sh] = 1;
      const tries = (sh === 'circuit' || sh === 'hairpin') ? 14 : 6;
      for (let attempt = 0; attempt < tries && !got; attempt++) {
        const cand = tryShape(sh, rng);
        if (cand && cand.len > 2400 && cand.len < 7400) { got = cand; shape = sh; }
      }
      if (got) break;
    }
    if (!got) {
      shape = 'blob';
      for (let attempt = 0; attempt < 12 && !got; attempt++) got = tryShape('blob', rng);
    }

    return {
      id: 'random', name: '隨機賽道', theme: rng.pick(['garden', 'veggie', 'pond', 'candy', 'shroom', 'branch']),
      desc: '每一局都不一樣的賽道（這張是「' + SHAPE_NAME[shape] + '」）。',
      shape: shape,
      stars: 3,
      /* 彎多的賽道一圈本來就久，圈數跟著長度調，全程才不會拖到三分鐘 */
      laps: got.len > 5600 ? 2 : 3,
      random: true, seed: seed,
      startNode: 0, itemCount: 12,
      ctrl: got.ctrl, boosts: got.boosts, mud: got.mud, rocks: got.rocks
    };
  }

  /** 依 id 取賽道；'random' 會用 seed 生一張新的 */
  function get(id, seed) {
    if (id === 'random') return build(randomDef(seed || RNG.newSeed()));
    return build(BY_ID[id] || BY_ID.garden);
  }

  function list() {
    return TRACKS.map(t => ({
      id: t.id, name: t.name, desc: t.desc, theme: t.theme, stars: t.stars, laps: t.laps
    }));
  }

  return {
    SURFACE, CELL, NODE_STEP, CHECKPOINTS, START_STRAIGHT_NODES, START_LANE_GAP,
    TRACKS, BY_ID, build, get, list, randomDef, SHAPES, SHAPE_NAME,
    surfaceAt, nodeAt, checkpointOf, lateralOf, sample, addTangents, idx
  };
});
