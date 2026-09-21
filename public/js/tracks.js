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
    BOOST: 3,   /* 露珠加速帶 */
    WATER: 4,   /* 水坑：比泥巴好一點，但會打滑 */
    UP: 5,      /* 上坡：慢下來 */
    DOWN: 6     /* 下坡：衝快一點 */
  };

  /* 地形代碼會被存進 Uint8Array，也會被存檔與網路封包引用，所以只准往後加，
   * 不准調換既有的數字。 */
  const SURFACE_MAX = 6;

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

    const raw = resample(dense, closed);
    /* 控制點被切角之後，Catmull-Rom 在角上會擠出半徑只有十幾單位的尖角：
     * 中心線一折，畫出來的路面就是一片一片歪掉的鋸齒，而且那種彎毛毛蟲
     * 根本轉不過去。先把中心線的曲率壓下來，之後畫路面、鋪地表格、
     * AI 走線用的都是同一條順的線。 */
    const smooth = smoothCurve(raw, closed);
    const out = resample(smooth.map(nd => [nd.x, nd.y, nd.w]), closed);
    /* 抹過之後彎道會被切短；build() 要靠這個比例把整張圖等比例放大補回來，
     * 長度回到原本那樣，彎道半徑也順便一起撐大。 */
    const before = polyLength(raw, closed), after = polyLength(out, closed);
    out.shrink = before > 1 ? after / before : 1;
    return out;
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
  const SMOOTH_SIGMA = 120;        /* 高斯的標準差（單位）；也大致是磨出來的最小轉彎半徑 */

  function polyLength(nodes, closed) {
    let L = 0;
    for (let i = 0; i + 1 < nodes.length; i++) L += Math.hypot(nodes[i + 1].x - nodes[i].x, nodes[i + 1].y - nodes[i].y);
    if (closed && nodes.length > 1) L += Math.hypot(nodes[0].x - nodes[nodes.length - 1].x, nodes[0].y - nodes[nodes.length - 1].y);
    return L;
  }

  function smoothCurve(nodes, closed) {
    /* 抹得太兇的話，來回折的兩段路有機會被平均在一起、整個塌掉。
     * 長度掉超過四成就換小一點的 σ 再來一次，形狀一定保得住。 */
    const before = polyLength(nodes, closed);
    for (let sigma = SMOOTH_SIGMA; sigma >= SMOOTH_SIGMA / 4; sigma /= 2) {
      const out = blurCurve(nodes, closed, sigma);
      if (out === nodes || polyLength(out, closed) >= before * 0.62) return out;
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

  /**
   * 把賽道的某一段整條塗成別的地形（上下坡用）。
   *
   * 跟 paintBlob 的差別是「一整段路」而不是「一個圓」——
   * 坡是有長度的，塗成圓的話跑起來會像踩到一個點，不像在爬坡。
   * 兩端各留一小段漸層（頭尾各 fade 個節點只塗中間一半寬），
   * 免得速度在邊界上一刀切。
   *
   * @param {number} from 起始節點 index
   * @param {number} to   結束節點 index（可以超過 nodes.length，會繞回去）
   */
  function paintSpan(grid, nodes, from, to, surface) {
    const n = nodes.length;
    const count = Math.max(1, to - from);
    const fade = Math.min(4, Math.floor(count / 4));
    for (let k = 0; k <= count; k++) {
      const i = ((from + k) % n + n) % n;
      const nd = nodes[i];
      /* 頭尾收窄：坡的邊緣不要是一條直角的線 */
      const edge = Math.min(k, count - k);
      const shrink = fade > 0 && edge < fade ? 0.45 + 0.55 * (edge / fade) : 1;
      const w = nd.w * shrink;
      const steps = Math.ceil(w / CELL) + 1;
      for (let s = -steps; s <= steps; s++) {
        const off = (s / steps) * w;
        const px = nd.x + nd.nx * off, py = nd.y + nd.ny * off;
        for (let t = -1; t <= 1; t++) {
          const c = cellOf(grid, px + nd.tx * t * CELL * 0.5, py + nd.ty * t * CELL * 0.5);
          if (c >= 0 && grid.surface[c] === SURFACE.TRACK) grid.surface[c] = surface;
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
        /* 只在路面上塗（含坡），泥巴／水坑／加速帶都不會長到草地上 */
        if (c >= 0 && grid.surface[c] !== SURFACE.GRASS) grid.surface[c] = surface;
      }
    }
  }

  /* ---------- 賽道機制的自動佈局 ----------
   *
   * 上下坡、水坑兩種都是「一段一段」或「一塊一塊」貼在賽道上的東西。
   * 二十張手設賽道逐張挑節點 index 不但煩，而且賽道幾何一動就全錯，
   * 所以改成從幾何算出來：直線段放坡，彎道出口放水坑。
   *
   * 全部走同一支 RNG（種子＝賽道 seed），所以：
   *   - 同一張賽道每次開出來都一樣（線上對戰兩邊算出來的必須一致）
   *   - 隨機賽道跟手設賽道共用同一套邏輯，不用寫兩份
   * def 裡有寫死的 slopes／water 就以 def 為準，不自動放。
   */

  /** 每個節點附近的彎度（弧度）。越大越彎。 */
  function curvature(nodes, open) {
    const n = nodes.length, out = new Float32Array(n);
    const at = i => nodes[open ? Math.max(0, Math.min(n - 1, i)) : ((i % n) + n) % n];
    for (let i = 0; i < n; i++) {
      const a = at(i - 4), b = at(i + 4);
      out[i] = Math.abs(Math.atan2(a.tx * b.ty - a.ty * b.tx, a.tx * b.tx + a.ty * b.ty));
    }
    return out;
  }

  /**
   * 找出「連續 len 個節點都夠直」的區段，由直到彎排序。
   * @returns {Array<{at:number, bend:number}>}
   */
  function straightRuns(curve, n, len, open, taken, maxWorst) {
    const runs = [];
    const last = open ? n - len : n - 1;
    for (let i = 0; i <= last; i++) {
      let sum = 0, worst = 0, clash = false;
      for (let k = 0; k < len; k++) {
        const j = ((i + k) % n + n) % n;
        if (taken[j]) { clash = true; break; }
        sum += curve[j];
        worst = Math.max(worst, curve[j]);
      }
      if (clash) continue;
      /* 單點爆彎的區段不要：平均直但中間有個髮夾，坡段會失去穩定性 */
      if (worst > maxWorst) continue;
      runs.push({ at: i, bend: sum / len });
    }
    runs.sort((a, b) => a.bend - b.bend);
    return runs;
  }

  /**
   * 找一段放得下的路，找不到就一路退讓：先縮短，再放寬彎度。
   *
   * 沒有這個退讓的話，糖果餅乾、雪地那種「整張都在轉」的賽道會一段都放不下，
   * 玩起來就是「有些賽道有機制、有些完全沒有」。彎道裡的坡其實很好玩，
   * 只是不能失去穩定性，所以放寬的是「平均多直」，上限（單點爆彎）還是擋著。
   *
   * @returns {{at:number, len:number}|null}
   */
  function findRun(curve, n, wantLen, open, taken, rng) {
    for (const shrink of [1, 0.75, 0.55, 0.4]) {
      const len = Math.max(10, Math.round(wantLen * shrink));
      for (const maxWorst of [0.30, 0.42, 0.58]) {
        const runs = straightRuns(curve, n, len, open, taken, maxWorst);
        if (!runs.length) continue;
        /* 從最直的前幾段裡抽，不然每張賽道都挑到同一種地方 */
        const pick = runs[rng.int(0, Math.min(runs.length - 1, 5))];
        return { at: pick.at, len: len };
      }
    }
    return null;
  }

  function markTaken(taken, n, from, len, pad) {
    for (let k = -pad; k < len + pad; k++) taken[(((from + k) % n) + n) % n] = 1;
  }

  /**
   * 幫一張賽道排好上下坡、水坑。
   * @param {object} opt { nodes, open, rng, startNode, boosts }
   */
  function placeFeatures(opt) {
    const nodes = opt.nodes, n = nodes.length, open = opt.open, rng = opt.rng;
    const curve = curvature(nodes, open);
    const taken = new Uint8Array(n);

    /* 起跑線前後淨空：開跑就撞進坡很莫名，而且會擋住起跑格 */
    markTaken(taken, n, opt.startNode - 14, 28, 0);

    const slopes = [], water = [], shortcuts = [];
    /* 賽道越長放越多，但都有上限 —— 一圈裡每種機制出現兩三次剛好，
     * 再多就變成「整張都是機制」，反而沒有記憶點。 */
    const scale = Math.min(1, n / 420);

    /* --- 上下坡：成對放，先上後下 ---
     * 成對是刻意的：一圈的淨高度必須是零，不然「一直下坡」就變成免費加速，
     * 圈速會整個垮掉。上坡在前、下坡在後，跑起來就是爬上去再衝下來。 */
    {
      const pairs = Math.max(1, Math.round(rng.range(1, 1 + scale * 1.5)));
      /* 一對放不下就換個地方再試。沒有這個重試的話，只要第一次抽到的上坡後面
       * 剛好卡住，整張賽道就一個坡都沒有 —— 實測二十張裡有六張這樣。 */
      for (let k = 0, tries = 0; k < pairs && tries < 8; tries++) {
        const before = slopes.length;
        const up = findRun(curve, n, rng.range(16, 28), open, taken, rng);
        if (!up) break;
        slopes.push([up.at, up.at + up.len, 1]);
        markTaken(taken, n, up.at, up.len, 6);

        /* 下坡擺在上坡後面一點點，中間隔一小段平路 */
        const gap = Math.round(rng.range(6, 18));
        const downLen = up.len;
        const at = up.at + up.len + gap;
        let clear = true;
        for (let i = -4; i < downLen + 4; i++) if (taken[(((at + i) % n) + n) % n]) { clear = false; break; }
        if (open && at + downLen >= n) clear = false;
        if (clear) {
          slopes.push([at, at + downLen, -1]);
          markTaken(taken, n, at, downLen, 6);
        } else {
          /* 放不下就把上坡也收掉 —— 寧可沒有坡，也不要只有上坡（那就是純扣速度）。
           * 佔位不還原：那個地方已經證實放不下一對，下一輪要換別的地方試。 */
          slopes.pop();
        }
        if (slopes.length > before) k++;
      }
    }

    /* --- 水坑：彎道出口最討厭，因為那裡最需要抓地力 --- */
    {
      const want = Math.round(rng.range(2, 3 + scale * 2));
      const cand = [];
      for (let i = 0; i < n; i++) {
        if (taken[i]) continue;
        /* 「彎道出口」＝自己這裡還在彎，但前面已經直了 */
        const ahead = curve[((i + 10) % n + n) % n];
        if (curve[i] > 0.10 && ahead < curve[i]) cand.push(i);
      }
      for (let k = 0; k < want && cand.length; k++) {
        const i = cand.splice(rng.int(0, cand.length - 1), 1)[0];
        if (taken[i]) continue;
        const nd = nodes[i];
        /* 偏一邊放，整條路封死的話沒有走線可選，只是純粹扣速度 */
        const off = nd.w * rng.range(0.18, 0.46) * (rng.chance(0.5) ? 1 : -1);
        water.push([nd.x + nd.nx * off, nd.y + nd.ny * off, rng.range(34, 52)]);
        markTaken(taken, n, i - 5, 10, 0);
      }
    }

    /* --- 捷徑：抄掉一個大彎 ---
     *
     * 找一對節點 (i, j)：沿著賽道跑很遠，但直線距離很近 —— 那中間就是一個大彎，
     * 從弦切過去就是捷徑。只在環形賽道上找（衝刺賽道抄捷徑會讓進度計算難算）。
     *
     * 要擋掉兩種爛捷徑：
     *   1. 跟主賽道平行的（弦剛好貼著路邊跑）——那不是捷徑，只是把路加寬。
     *      檢查弦的中點離主賽道夠不夠遠。
     *   2. 太好賺的 —— 省掉半圈的話沒有人會走正路，賽道就沒意義了。
     */
    if (!open && n >= 200) {
      const want = rng.chance(0.62) ? 1 : 0;
      for (let k = 0; k < want; k++) {
        const cand = [];
        const minArc = Math.round(n * 0.16), maxArc = Math.round(n * 0.34);
        for (let i = 0; i < n; i += 3) {
          for (let arc = minArc; arc <= maxArc; arc += 4) {
            const j = (i + arc) % n;
            const a = nodes[i], b = nodes[j];
            const chord = Math.hypot(b.x - a.x, b.y - a.y);
            const along = arc * NODE_STEP;
            if (chord > along * 0.60) continue;          /* 省得不夠多，不值得當捷徑 */
            if (chord < (a.w + b.w) * 2.2) continue;     /* 太短，等於把兩段路黏在一起 */

            /* 弦的中點要離主賽道夠遠，才不是「貼著路邊的第二條路」 */
            const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
            let near = Infinity;
            for (let q = 0; q < n; q += 2) {
              const dx = nodes[q].x - mx, dy = nodes[q].y - my;
              near = Math.min(near, Math.hypot(dx, dy));
            }
            if (near < a.w * 2.0) continue;

            cand.push({ i: i, j: j, gain: along - chord, chord: chord });
          }
        }
        if (!cand.length) break;
        /* 省最多的那幾條裡抽一條 */
        cand.sort((x, y) => y.gain - x.gain);
        const pick = cand[rng.int(0, Math.min(cand.length - 1, 7))];
        const a = nodes[pick.i], b = nodes[pick.j];

        /* 控制點：兩端沿著賽道的切線方向拉出去一點，捷徑才會「順順地」接上主賽道，
         * 而不是兩個直角。中間那點往弦的外側推一點點，跑起來才有弧度。 */
        const w = Math.max(24, Math.min(a.w, b.w) * 0.52);
        const out = pick.chord * 0.22;
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        /* 往遠離主賽道中心的那一側推：賽道的重心大致在所有節點的平均 */
        let cx = 0, cy = 0;
        for (let q = 0; q < n; q++) { cx += nodes[q].x; cy += nodes[q].y; }
        cx /= n; cy /= n;
        const bulge = Math.hypot(mx - cx, my - cy) > 1e-3
          ? { x: (mx - cx) / Math.hypot(mx - cx, my - cy), y: (my - cy) / Math.hypot(mx - cx, my - cy) }
          : { x: 0, y: 0 };
        const push = pick.chord * 0.06;

        shortcuts.push({
          from: pick.i, to: pick.i + ((pick.j - pick.i + n) % n),
          ctrl: [
            [a.x, a.y, w],
            [a.x + a.tx * out, a.y + a.ty * out, w],
            [mx + bulge.x * push, my + bulge.y * push, w],
            [b.x - b.tx * out, b.y - b.ty * out, w],
            [b.x, b.y, w]
          ]
        });
      }
    }

    return { slopes, water, shortcuts, curve };
  }

  /* ---------- 交通標誌 ----------
   *
   * 路邊的警告牌，提前告訴玩家前面要變什麼。追尾視角看不到遠處的路型，
   * 沒有標誌的話「前面是左彎還是右彎」只能靠背賽道，第一次跑一定吃虧。
   *
   * 全部從幾何與機制佈局算出來，所以手設與隨機賽道都自動有，
   * 而且賽道一改標誌就跟著改，不會指錯方向。
   */

  /** 標誌擺在機制／彎道前面幾個節點（14 單位一個節點，約兩秒的反應時間） */
  const SIGN_LEAD = 20;
  /** 同一種標誌至少要隔這麼多節點，才不會連續插一排一樣的牌子 */
  const SIGN_SPACING = 24;
  /**
   * 任意兩塊牌子（不分種類）至少要隔這麼多節點。
   * 28 個節點約 390 單位，以基礎速度 150 跑過去約 2.6 秒 ——
   * 一塊牌子看完、反應完，才輪到下一塊。
   *
   * 沒有這條的話只有「同種類」之間有間距，不同種類會疊在一起：
   * 實測有四對牌子站在同一個節點上，一百一十五對間隔不到 20 個節點。
   */
  const SIGN_MIN_GAP = 28;
  /**
   * 擠在一起只能留一塊時，留哪一種。排前面的優先。
   *
   * 排序的依據是「不知道的話代價多大」：
   *   路型（連續彎、左右轉）走錯線最貴，而且是唯一沒看到牌子就完全猜不到的；
   *   水坑會讓車滑出去，但至少看得到地上有一塊亮的；
   *   上下坡只是快慢，看不到也不會撞；
   *   上下坡只影響速度，提示牌放在路邊讓玩家提早準備。
   */
  const SIGN_RANK = ['sturn', 'left', 'right', 'turn', 'water', 'up', 'down'];

  /**
   * @param {object} opt { nodes, open, curve, startNode, slopes, water }
   * @returns {Array<{x:number, y:number, kind:string, node:number}>}
   */
  function placeSigns(opt) {
    const nodes = opt.nodes, n = nodes.length, open = opt.open, curve = opt.curve;
    const wrap = i => ((i % n) + n) % n;
    const signs = [];
    const usedAt = {};        /* kind -> 上一次擺在哪個節點 */

    /**
     * 把一個標誌擺在 node 的路邊。
     *
     * 優先右手邊（跟真實道路一樣，玩家的視線習慣），但一定要落在草地上 ——
     * 窄又會折回來的賽道（大樹枝幹那張）右邊常常就是另一段路面，
     * 牌子立在路面上會被誤認成障礙物，而且會被路面的顏色蓋掉。
     * 右邊不行就換左邊，兩邊都不行就往外推，真的都沒地方就放棄這一塊。
     */
    function put(kind, at, okNode) {
      /* 目標節點不能用就往後退著找（一定要退，不能往前 —— 標誌得在事件前面）。 */
      let at2 = at;
      if (okNode) {
        let found = false;
        for (let back = 0; back <= 16; back++) {
          if (okNode(wrap(at - back))) { at2 = at - back; found = true; break; }
        }
        if (!found) return;
      }
      const i = wrap(at2);
      if (open && (at < 2 || at > n - 3)) return;      /* 衝刺賽道的兩端不擺 */
      const last = usedAt[kind];
      if (last !== undefined) {
        const gap = Math.abs(((i - last + n * 1.5) % n) - n * 0.5);
        if (gap < SIGN_SPACING) return;                /* 同一種牌子不要連插一排 */
      }
      if (open && (at2 < 2 || at2 > n - 3)) return;
      const nd = nodes[i];
      for (const extra of [42, 78, 124]) {
        for (const side of [1, -1]) {
          const off = nd.w + extra;
          const x = nd.x + nd.nx * off * side;
          const y = nd.y + nd.ny * off * side;
          if (!opt.isClear(x, y)) continue;
          signs.push({ x: x, y: y, kind: kind, node: i, side: side });
          usedAt[kind] = i;
          return;
        }
      }
    }

    /* --- 機制的預告牌 --- */
    /* 坡牌不能立在同方向的坡上
     *（下坡預告立在上坡上是對的 —— 真實道路的陡降標誌就在爬坡快到頂的地方）。 */
    const slopeOf = slopeMask(opt.slopes, n);
    for (const sp of opt.slopes) {
      const want = sp.dir > 0 ? 1 : -1;
      put(sp.dir > 0 ? 'up' : 'down', sp.from - SIGN_LEAD, i => slopeOf[i] !== want);
    }
    for (const w of opt.water) {
      /* 水坑是座標不是節點，先找它在哪一段路上 */
      let best = -1, bd = Infinity;
      for (let i = 0; i < n; i++) {
        const dx = nodes[i].x - w[0], dy = nodes[i].y - w[1];
        const d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = i; }
      }
      if (best >= 0) put('water', best - SIGN_LEAD);
    }

    /**
     * 牌子前面那段路，總共往哪邊轉幾度（畫面上的左右）。
     *
     * 量的是「淨轉向量」：把那一段每一步的轉向累加起來。這是道路標誌的
     * 定義本身 —— 一個左轉彎牌的意思就是「接下來這條路往左轉了幾十度」。
     *
     * 左右的正負要注意：投影的橫向是 r = -(dx)*sin + (dy)*cos，所以面向 +x 時
     * 世界 +y 落在畫面「右邊」，畫出來的座標系相對數學慣例是鏡像的 ——
     * 世界的逆時針（外積為正）在畫面上看起來是「右轉」。
     *
     * 之前試過兩種都不夠好：
     *   - 直接用彎道偵測時的外積 → 方向反了（89 塊裡 64 塊錯）。
     *   - 用「沿法線的橫向偏移」加透視加權 → 方向對了，但複合彎與
     *     幾乎打直的路會給出很小又不穩的值，實測跟實際畫面有 19 塊不合。
     * 淨轉向量沒有這些問題：它不看橫向位移，只看方向轉了多少，
     * 所以 S 彎的兩段會互相抵銷（那本來就該立 S 彎的牌子，不是左右轉）。
     *
     * @returns {number} 弧度。>0 畫面右、<0 畫面左
     */
    function netTurn(i) {
      let sum = 0, pos = 0, neg = 0;
      /* 6～44 個節點＝約 84～616 單位，玩家在牌子前看得到的那一段 */
      for (let k = 6; k < 44; k++) {
        const j = open ? i + k : wrap(i + k);
        if (open && j > n - 2) break;
        const a = nodes[j], b = nodes[open ? Math.min(n - 1, j + 1) : wrap(j + 1)];
        /* 外積為正＝世界逆時針＝畫面上往右 */
        const d = Math.atan2(a.tx * b.ty - a.ty * b.tx, a.tx * b.tx + a.ty * b.ty);
        sum += d;
        if (d > 0) pos += d; else neg -= d;
      }
      /* pos／neg 分開記：兩邊都轉了不少就是複合彎，不是單純的左轉或右轉 */
      return { net: sum, pos: pos, neg: neg };
    }

    /** 淨轉向量小於這個就不立左右轉的牌子 —— 路幾乎是直的，指哪邊都是錯的 */
    const TURN_MIN_NET = 0.28;      /* 約 16 度 */
    /**
     * 兩個方向都轉超過這麼多，就當成複合彎，一樣不立左右轉的牌子。
     *
     * 沒有這條的話會出現「淨轉向往右，但玩家眼前那一段先往左」的牌子 ——
     * 實測 candy@324 就是這樣，牌子寫右，畫面上先往左偏 49 像素。
     * 那種路型立一塊「右轉」只會害人，它要嘛是 S 彎要嘛不該有牌子。
     */
    const TURN_MAX_OPPOSITE = 0.16;   /* 約 9 度 */

    /* --- 彎道的預告牌 ---
     * 先把賽道切成「彎段」：彎度連續超過門檻的一串節點算一個彎，
     * 順便記它往左還是往右（切線的外積）。 */
    const TURN_IN = 0.16;         /* 超過這個彎度才算一個彎 */
    const corners = [];
    let run = null;
    for (let k = 0; k < (open ? n : n + 20); k++) {
      const i = wrap(k);
      if (curve[i] >= TURN_IN) {
        const a = nodes[wrap(i - 4)], b = nodes[wrap(i + 4)];
        /* 這裡的 dir 只用來把「連續同向的節點」黏成一個彎，以及判斷下一個彎
         * 是不是反向（連續彎要立 S 彎的牌子）。正負代表哪一邊不重要，
         * 一致就夠了 —— 牌子最後寫左還是寫右，統一由 screenTurn() 重算。 */
        const dir = (a.tx * b.ty - a.ty * b.tx) >= 0 ? 1 : -1;
        if (run && run.dir === dir) { run.to = i; run.sum += curve[i]; }
        else { if (run) corners.push(run); run = { from: i, to: i, dir: dir, sum: curve[i] }; }
      } else if (run) { corners.push(run); run = null; }
      if (!open && k >= n && corners.length && corners[0].from === wrap(k)) break;
    }
    if (run) corners.push(run);

    /* 太短太緩的彎不值得立牌 —— 整張賽道插滿牌子等於沒有牌子 */
    const real = corners.filter(c => {
      const len = ((c.to - c.from + n) % n) + 1;
      return len >= 5 && c.sum >= 0.9;
    });

    /* 連續彎：下一個彎方向相反、而且很近 —— 立「S 彎」而不是兩塊左右轉 */
    const paired = new Uint8Array(real.length);
    for (let k = 0; k < real.length; k++) {
      const a = real[k], b = real[(k + 1) % real.length];
      if (real.length < 2) break;
      if (!open && k === real.length - 1 && real.length < 3) break;
      const gap = ((b.from - a.to + n) % n);
      if (b.dir !== a.dir && gap <= 10) {
        paired[k] = 1; paired[(k + 1) % real.length] = 1;
        put('sturn', a.from - SIGN_LEAD);
      }
    }
    for (let k = 0; k < real.length; k++) {
      if (paired[k]) continue;
      /* 先立一塊「轉彎」，左右等牌子的位置定下來再算 */
      put('turn', real[k].from - SIGN_LEAD);
    }

    /* 轉彎牌的左右，統一從牌子最後站的位置往前量 ——
     * 牌子會被間距限制與「往後退著找可用節點」推移，推移之後前方那個彎
     * 可能已經換成別的了，所以不能在彎那邊算好左右再立牌。
     *
     * 淨轉向量太小的那些直接撤牌：那段路幾乎是直的，指左指右都是錯的，
     * 而且玩家看到一塊「左轉」卻沒有彎，反而會不信後面的牌子。 */
    for (const sg of signs) {
      if (sg.kind !== 'turn') continue;
      const t = netTurn(sg.node);
      /* 轉得不夠多（幾乎是直的）或兩邊都轉（複合彎）都不立牌 */
      const weak = Math.abs(t.net) < TURN_MIN_NET;
      const mixed = Math.min(t.pos, t.neg) > TURN_MAX_OPPOSITE;
      sg.kind = (weak || mixed) ? '' : (t.net < 0 ? 'left' : 'right');
    }

    /* 'turn' 是暫時的種類，到這裡應該都換成 left／right 或被清成空字串了。
     * 空字串的是「那段路太直，不值得立牌」，整塊移掉。 */
    for (let i = signs.length - 1; i >= 0; i--) {
      if (signs[i].kind === 'turn' || signs[i].kind === '') signs.splice(i, 1);
    }

    /* 起跑線附近不要立牌（擋住起跑格，而且開跑瞬間看不清楚） */
    let out = signs.filter(sg => {
      const d = Math.abs(((sg.node - opt.startNode + n * 1.5) % n) - n * 0.5);
      return d > 8;
    });

    /* ---- 疏開：擠在一起的只留一塊 ----
     *
     * 前面每一種機制是各自挑位置的，所以不同種類會撞在一起（實測有四對
     * 站在同一個節點上）。連著三塊牌子閃過去，玩家一塊都讀不到，
     * 等於沒有牌子 —— 寧可少一塊，也不要插成一排。
     *
     * 沿賽道順序掃一遍：跟上一塊留下來的太近就比優先序，贏的那塊留下。
     * 環形賽道要多比一次頭尾（最後一塊跟第一塊也是鄰居）。
     */
    const rankOf = k => {
      const i = SIGN_RANK.indexOf(k);
      return i < 0 ? SIGN_RANK.length : i;
    };
    out.sort((a, b) => a.node - b.node);

    const kept = [];
    for (const sg of out) {
      const last = kept[kept.length - 1];
      if (last && sg.node - last.node < SIGN_MIN_GAP) {
        /* 太近：優先序高的留下（同分就留先到的，也就是賽道上比較前面那塊） */
        if (rankOf(sg.kind) < rankOf(last.kind)) kept[kept.length - 1] = sg;
        continue;
      }
      kept.push(sg);
    }
    /* 環形賽道的頭尾也是鄰居 */
    if (!open && kept.length > 1) {
      const first = kept[0], last = kept[kept.length - 1];
      if (n - last.node + first.node < SIGN_MIN_GAP) {
        if (rankOf(first.kind) < rankOf(last.kind)) kept.pop();
        else kept.shift();
      }
    }

    return kept;
  }

  /** 每個節點是上坡（+1）、下坡（-1）還是平路（0）。畫面用，物理一律查 grid。 */
  function slopeMask(slopes, n) {
    const mask = new Int8Array(n);
    for (const s of slopes) {
      for (let i = s.from; i <= s.to; i++) mask[((i % n) + n) % n] = s.dir;
    }
    return mask;
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
    let raw = sample(ctrl, !open);
    let grow = 1;
    /* 平滑會把急彎切短。等比例放大補回來：賽道長度跟原本一樣，
     * 但每個彎的半徑都跟著變大 —— 這是高速時轉不過彎的主因。
     * 放大之後同樣的 σ 相對變弱，縮水也會變少，所以跑幾輪讓它收斂。 */
    const FIX_MAX = 1.30;             /* 補償最多放大到這樣，免得賽道被拉得又臭又長 */
    let fixed = 1;
    for (let round = 0; round < 4; round++) {
      const sh = raw.shrink || 1;
      if (sh > 0.985) break;
      const fix = Math.min(1 / sh, FIX_MAX / fixed);
      if (fix <= 1.005) break;
      fixed *= fix;
      grow *= fix;
      ctrl = ctrl.map(p => [p[0] * fix, p[1] * fix, p[2]]);
      raw = sample(ctrl, !open);
    }
    let nodes = addTangents(raw, !open);
    let wideK = fitWiden(nodes);
    /* 有些賽道（菜園迷宮、夜光蘑菇）自己繞回來的地方本來就很擠，
     * 路面根本加不寬。那就把整張圖等比例放大 —— 形狀一模一樣，
     * 只是彎跟彎之間空出距離，路面才寬得起來。 */
    const avgW = () => nodes.reduce((a, nd) => a + nd.w, 0) / nodes.length;
    if (wideK.k < 1.35 || avgW() < 112) {
      const GROW = 1.32;
      grow *= GROW;
      ctrl = ctrl.map(p => [p[0] * GROW, p[1] * GROW, p[2]]);
      nodes = addTangents(sample(ctrl, !open), !open);
      wideK = fitWiden(nodes);
    }
    /* 起跑格的位置要先知道，機制佈局才躲得開起跑線 */
    const startNode = chooseStartNode(nodes, open, def.startNode);

    /* def 機制都沒寫就自動佈局。有寫任何一種就整包以 def 為準 ——
     * 半自動半手動的話，手設的那一種會被自動的那一種蓋掉，很難除錯。 */
    const authored = !!(def.slopes || def.water);
    const auto = authored ? { slopes: [], water: [], shortcuts: [] }
      : placeFeatures({
        nodes: nodes, open: open, startNode: startNode,
        rng: RNG.create((def.seed || def.id || 'track') + ':feat')
      });

    /* 自動生的捷徑座標已經是最終座標（從 nodes 算出來的），
     * 不能再乘 grow，也不用再 widenBy —— 寬度是算的時候就定好的。
     * def 寫死的那些還是走原本的路徑（原始座標 ＋ grow ＋ widenBy）。 */
    const shortcuts = (def.shortcuts || []).map(sc => ({
      nodes: widenBy(addTangents(sample(
        grow === 1 ? sc.ctrl : sc.ctrl.map(p => [p[0] * grow, p[1] * grow, p[2]]), false), false), wideK),
      /* 捷徑接回主賽道的節點 index，用來讓進度計算不會倒退 */
      from: sc.from, to: sc.to
    })).concat((def.shortcuts ? [] : auto.shortcuts || []).map(sc => ({
      nodes: addTangents(sample(sc.ctrl, false), false),
      from: sc.from, to: sc.to
    })));

    /* 捷徑的 from／to 一律從幾何重算，不信 def 裡寫的。
     *
     * 理由跟 mud／boost 走 ontoRoad 一樣：賽道會被 fitWiden／GROW 放大、
     * 急彎會被抹平，手寫的節點 index 對不上實際幾何。實測三條手設捷徑
     * 全都寫錯 —— 宣稱取代 336 單位的正路，本身卻有 966 單位長，
     * 也就是「捷徑」其實比正路遠，而且進度對應被壓縮成三分之一。
     *
     * 重算法：捷徑頭尾各找主賽道上最近的節點。to 一定要在 from 前面（沿賽道方向），
     * 繞回去的那一邊才是它真正取代的區間。 */
    for (const sc of shortcuts) {
      const n = nodes.length;
      const near = (x, y) => {
        let best = -1, bd = Infinity;
        for (let i = 0; i < n; i++) {
          const dx = nodes[i].x - x, dy = nodes[i].y - y;
          const d = dx * dx + dy * dy;
          if (d < bd) { bd = d; best = i; }
        }
        return best;
      };
      const head = sc.nodes[0], tail = sc.nodes[sc.nodes.length - 1];
      const a0 = near(head.x, head.y), b0 = near(tail.x, tail.y);
      if (a0 < 0 || b0 < 0) continue;
      /* 沿賽道方向從 a0 走到 b0 要幾步（環形就繞回去） */
      const span = open ? (b0 - a0) : (((b0 - a0) % n) + n) % n;
      if (span <= 0) continue;
      sc.from = a0;
      sc.to = a0 + span;
    }

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
    /* 加速帶與泥巴的座標是寫死的；賽道幾何一調整（放大、抹平急彎）就可能被甩到
     * 路肩外面。統一拉回最近的那段路面上，位置感覺一樣，但永遠不會掉到草地。 */
    const ontoRoad = (x, y) => {
      let best = Infinity, bn = -1;
      for (let i = 0; i < nodes.length; i++) {
        const dx = nodes[i].x - x, dy = nodes[i].y - y;
        const d = dx * dx + dy * dy;
        if (d < best) { best = d; bn = i; }
      }
      if (bn < 0) return [x, y];
      const nd = nodes[bn];
      const off = (x - nd.x) * nd.nx + (y - nd.y) * nd.ny;
      const lim = nd.w * 0.72;
      const k = off > lim ? lim : (off < -lim ? -lim : off);
      /* 沿著切線的那一點分量保留，橫向才是被夾住的那個 */
      const along = (x - nd.x) * nd.tx + (y - nd.y) * nd.ty;
      const keep = Math.max(-NODE_STEP, Math.min(NODE_STEP, along));
      return [nd.x + nd.tx * keep + nd.nx * k, nd.y + nd.ty * keep + nd.ny * k];
    };
    const mudList = (def.mud || []).map(m => {
      const p2 = ontoRoad(m[0] * grow, m[1] * grow);
      return [p2[0], p2[1], m[2]];
    });
    const boostList = (def.boosts || []).map(b => {
      const p2 = ontoRoad(b[0] * grow, b[1] * grow);
      return [p2[0], p2[1], b[2]];
    });
    const waterList = (def.water || auto.water).map(w => {
      const p2 = ontoRoad(w[0] * grow, w[1] * grow);
      return [p2[0], p2[1], w[2]];
    });

    /* 上下坡是「一段路」不是「一個點」，所以用節點區間描述。
     * 節點是等間距取樣出來的（NODE_STEP），所以 to - from 就是坡的長度。
     * 賽道會因為 fitWiden／GROW 被放大，但節點 index 不會跟著變，
     * 所以坡的位置不用像 mud／boost 那樣拉回路面上。 */
    const slopeList = (def.slopes || auto.slopes)
      .map(s => ({ from: s[0], to: s[1], dir: s[2] > 0 ? 1 : -1 }))
      .filter(s => s.to > s.from);

    /* 順序有意義：後塗的蓋前塗的。
     * 坡先塗（面積最大），水坑與泥巴壓在上面，加速帶最後 ——
     * 這樣「坡上有個水坑」畫得出來，而加速帶永遠不會被別的東西蓋掉。 */
    for (const s of slopeList) paintSpan(grid, nodes, s.from, s.to, s.dir > 0 ? SURFACE.UP : SURFACE.DOWN);
    for (const w of waterList) paintBlob(grid, w[0], w[1], w[2], SURFACE.WATER);
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
      water: waterList.map(r => ({ x: r[0], y: r[1], r: r[2] })),
      slopes: slopeList,
      slopeAt: slopeMask(slopeList, nodes.length),
      signs: placeSigns({
        nodes: nodes, open: open, startNode: startNode,
        /* 牌子只能立在草地上。grid 這時已經塗好了（含捷徑），所以查得到。 */
        isClear: (x, y) => {
          if (x < bounds.minX + 20 || x > bounds.maxX - 20) return false;
          if (y < bounds.minY + 20 || y > bounds.maxY - 20) return false;
          const c = cellOf(grid, x, y);
          return c >= 0 && grid.surface[c] === SURFACE.GRASS;
        },
        /* def 自己寫死機制時 auto.curve 是空的，這裡補算一份 */
        curve: auto.curve || curvature(nodes, open),
        slopes: slopeList,
        water: waterList
      }),
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

  /* ---------- 二十張手設賽道 ---------- */

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
    },
    {
      /* bloomloop circuit seed=bloomloop-0 彎道 16 長度 6188 路寬 133 半徑 min 61/p5 114 一圈 33.6s 葉 24 */
      id: 'bloomloop', name: '花海圓舞', theme: 'bloom', stars: 2, laps: 2,
      desc: '花開滿地的大平原，連續長彎一個接一個，適合練習高速走線。',
      startNode: 0, itemCount: 14,
      ctrl: [
        [-555, 216, 93], [-577, 108, 104], [-433, -112, 78], [-355, -154, 99], [-341, -145, 93],
        [-265, -182, 88], [-250, -205, 97], [-246, -290, 97], [-259, -299, 100], [-252, -387, 104],
        [-130, -573, 85], [-32, -602, 96], [-11, -588, 93], [66, -585, 82], [75, -598, 92],
        [152, -595, 90], [174, -581, 101], [207, -511, 100], [199, -498, 90], [192, -455, 83],
        [198, -451, 81], [190, -406, 104], [181, -393, 81], [212, -323, 102], [232, -310, 89],
        [309, -309, 80], [317, -322, 81], [356, -346, 79], [363, -342, 98], [354, -293, 91],
        [344, -279, 81], [381, -200, 95], [404, -185, 79], [491, -182, 85], [501, -197, 83],
        [565, -209, 100], [581, -199, 95], [581, -114, 100], [567, -91, 82], [493, -54, 103],
        [480, -63, 95], [403, -20, 100], [385, 8, 94], [376, 95, 102], [389, 104, 79],
        [413, 143, 100], [408, 149, 83], [363, 143, 79], [349, 134, 85], [284, 157, 85],
        [273, 175, 86], [277, 244, 100], [291, 252, 94], [310, 298, 95], [305, 307, 82],
        [256, 308, 98], [243, 300, 99], [167, 343, 99], [146, 374, 86], [137, 462, 91],
        [149, 470, 92], [143, 553, 79], [127, 577, 85], [22, 595, 97], [-207, 444, 93],
        [-247, 363, 90], [-237, 348, 89], [-270, 271, 85], [-292, 256, 80], [-375, 257, 95],
        [-385, 272, 92], [-476, 268, 93]
      ],
      boosts: [[79, -1013, 47], [464, 497, 47]],
      mud: [[-890, 1, 47], [-467, -563, 46], [537, -523, 41], [846, -118, 55], [6, 975, 51], [-523, 438, 55]],
      rocks: [[-1125, 509, 32], [-61, -789, 30], [473, -1026, 25], [407, -339, 28], [949, 102, 25], [706, 397, 35], [265, 388, 38], [395, 1077, 36], [-255, 447, 32], [-735, 200, 36]]
    },
    {
      /* lavaloop hairpin seed=lavaloop-1 彎道 17 長度 4550 路寬 147 半徑 min 83/p5 110 一圈 23.9s 葉 22 */
      id: 'lavaloop', name: '熔岩環道', theme: 'volcano', stars: 4, laps: 2,
      desc: '火山口旁邊的黑石賽道，髮夾彎一個接一個，煞不住就掉進黑土裡。',
      startNode: 0, itemCount: 14,
      ctrl: [
        [216, 580, 85], [129, 582, 84], [55, 510, 99], [-28, 507, 98], [-43, 522, 86],
        [-127, 519, 98], [-171, 476, 82], [-176, 393, 90], [-161, 378, 94], [-150, 311, 82],
        [-160, 300, 81], [-221, 307, 78], [-233, 320, 92], [-310, 310, 101], [-353, 268, 97],
        [-365, 192, 97], [-352, 179, 102], [-338, 127, 87], [-345, 121, 85], [-401, 140, 104],
        [-414, 154, 82], [-495, 149, 89], [-525, 120, 97], [-533, 39, 95], [-519, 24, 104],
        [-527, -56, 88], [-585, -112, 81], [-586, -200, 99], [-514, -274, 104], [-430, -279, 103],
        [-415, -264, 99], [-339, -262, 84], [-325, -276, 87], [-330, -352, 86], [-345, -367, 96],
        [-343, -451, 98], [-216, -580, 97], [-129, -582, 97], [-62, -517, 79], [20, -512, 80],
        [34, -527, 84], [116, -522, 82], [147, -492, 100], [154, -410, 86], [140, -395, 104],
        [144, -317, 82], [159, -302, 88], [239, -301, 90], [254, -317, 88], [332, -318, 88],
        [347, -303, 93], [348, -224, 94], [334, -209, 94], [324, -141, 97], [336, -130, 104],
        [395, -132, 95], [406, -144, 92], [480, -132, 94], [497, -116, 92], [511, -43, 88],
        [499, -31, 98], [514, 43, 84], [585, 112, 88], [586, 200, 84], [509, 280, 86],
        [426, 286, 83], [411, 271, 94], [329, 277, 85], [272, 336, 97], [268, 418, 92],
        [283, 433, 90], [279, 516, 81]
      ],
      boosts: [[-7, 675, 57], [379, -381, 46], [420, 413, 48]],
      mud: [[-415, 354, 50], [-735, -73, 54], [-473, -477, 50], [-35, -698, 51], [666, 68, 49]],
      rocks: [[357, 921, 30], [-4, 414, 28], [-246, 122, 25], [-436, -31, 37], [-506, -128, 36], [437, -607, 32], [703, -350, 31], [891, -126, 32], [304, 230, 34], [156, 542, 24]]
    },
    {
      /* starloop circuit seed=starloop-16 彎道 16 長度 4634 路寬 159 半徑 min 72/p5 113 一圈 25.8s 葉 21 */
      id: 'starloop', name: '星空草原', theme: 'starry', stars: 3, laps: 2,
      desc: '星空下的夜跑，路面會發微光，看得到的只有前面那一段。',
      startNode: 0, itemCount: 14,
      ctrl: [
        [172, -556, 94], [272, -510, 83], [293, -454, 95], [359, -395, 80], [373, -401, 91],
        [429, -366, 86], [436, -347, 97], [417, -284, 80], [403, -278, 81], [372, -247, 98],
        [374, -240, 97], [331, -204, 89], [312, -197, 92], [289, -107, 102], [299, -80, 89],
        [375, -29, 81], [394, -36, 99], [451, -35, 78], [454, -27, 79], [415, 10, 87],
        [397, 17, 102], [374, 100, 94], [384, 125, 85], [455, 172, 84], [473, 165, 89],
        [540, 202, 92], [548, 223, 96], [496, 305, 86], [432, 329, 87], [374, 398, 97],
        [380, 414, 92], [323, 482, 96], [289, 495, 98], [201, 481, 92], [195, 465, 86],
        [124, 445, 102], [103, 452, 88], [66, 521, 91], [73, 539, 92], [18, 614, 85], [-16, 627, 94],
        [-107, 607, 84], [-114, 588, 97], [-179, 559, 90], [-197, 565, 103], [-269, 520, 99],
        [-278, 495, 94], [-262, 416, 92], [-247, 411, 83], [-234, 326, 93], [-244, 300, 91],
        [-310, 245, 94], [-325, 251, 100], [-371, 249, 96], [-373, 243, 80], [-419, 242, 89],
        [-434, 248, 98], [-497, 204, 102], [-505, 181, 95], [-487, 107, 100], [-472, 101, 92],
        [-442, 59, 86], [-446, 48, 102], [-507, 40, 82], [-526, 47, 80], [-597, 12, 79],
        [-605, -9, 85], [-575, -82, 90], [-556, -90, 86], [-532, -180, 94], [-542, -207, 100],
        [-496, -305, 86], [-425, -331, 94], [-334, -311, 88], [-327, -292, 84], [-240, -270, 81],
        [-214, -280, 85], [-163, -354, 99], [-169, -373, 95], [-115, -448, 92]
      ],
      boosts: [[564, 447, 46], [-331, 538, 54], [-595, -382, 54], [-103, -590, 59]],
      mud: [[467, -563, 49], [489, -33, 43], [90, 710, 51], [-601, 102, 49]],
      rocks: [[233, -912, 26], [305, -366, 36], [778, 72, 32], [905, 430, 25], [577, 774, 36], [-12, 472, 36], [-602, 540, 31], [-612, 563, 36], [-525, -106, 42], [-469, -158, 36], [-485, -182, 26], [164, -417, 41]]
    },
    {
      /* 衝刺賽道：open ＝ 起點到終點，沒有圈數。forestrun seed=forestrun-15 長度 9534 節點 681 路寬 241 半徑 min 514/p2 612 全程 47.9s 葉 26 */
      id: 'forestrun', name: '林間長征', theme: 'branch', stars: 2, laps: 1, open: true,
      desc: '從林子這頭跑到那頭，沒有圈數。路又寬又長，適合練習長直線接彎。',
      startNode: 0, itemCount: 14,
      ctrl: [
        [-4597, -28, 97], [-4269, 12, 121], [-3975, 160, 108], [-3686, 320, 105], [-3371, 419, 97],
        [-3045, 373, 121], [-2727, 462, 114], [-2406, 385, 102], [-2077, 367, 115],
        [-1747, 369, 108], [-1436, 256, 105], [-1158, 80, 117], [-838, -4, 109], [-546, -158, 108],
        [-217, -181, 98], [104, -258, 108], [387, -428, 97], [715, -459, 115], [1036, -383, 106],
        [1366, -394, 115], [1692, -346, 117], [2020, -303, 99], [2320, -167, 113], [2650, -175, 121],
        [2975, -233, 108], [3295, -315, 103], [3616, -389, 113], [3943, -432, 115],
        [4272, -404, 110], [4597, -462, 111]
      ],
      boosts: [[-4187, 52, 54], [-3412, 401, 60], [-2566, 426, 52], [-936, 19, 57], [-120, -202, 55], [684, -452, 57], [2358, -174, 55]],
      mud: [[-1728, 302, 52], [1536, -406, 43], [3196, -304, 43], [4042, -461, 52]],
      rocks: [[-4208, 442, 41], [-3006, 768, 28], [-835, -412, 34], [-37, 141, 40], [976, -99, 27], [1548, 10, 30], [2805, 172, 35], [4418, -765, 26]]
    },
    {
      /* 衝刺賽道：open ＝ 起點到終點，沒有圈數。lakeside seed=lakeside-0 長度 10178 節點 727 路寬 235 半徑 min 301/p2 496 全程 54.7s 葉 26 */
      id: 'lakeside', name: '湖岸縱走', theme: 'pond', stars: 3, laps: 1, open: true,
      desc: '沿著湖岸一路跑到底，沒有圈數。彎緩但很長，體力（跟道具）要留著。',
      startNode: 0, itemCount: 14,
      ctrl: [
        [-4247, -1853, 108], [-3955, -2007, 108], [-3637, -1919, 102], [-3334, -1788, 116],
        [-3099, -1556, 99], [-2829, -1368, 115], [-2605, -1125, 106], [-2301, -996, 104],
        [-2071, -760, 101], [-1872, -497, 112], [-1680, -228, 106], [-1488, 40, 95],
        [-1296, 308, 111], [-1104, 577, 98], [-801, 708, 106], [-489, 814, 101], [-159, 813, 114],
        [171, 810, 109], [487, 906, 95], [739, 1119, 115], [936, 1384, 97], [1226, 1542, 118],
        [1553, 1582, 110], [1882, 1608, 105], [2186, 1479, 117], [2510, 1415, 100], [2823, 1313, 99],
        [3152, 1287, 114], [3458, 1412, 114], [3733, 1595, 106], [4000, 1788, 109], [4247, 2007, 98]
      ],
      boosts: [[-1707, -266, 57], [-330, 816, 59], [562, 965, 52], [1262, 1542, 58], [3062, 1291, 56]],
      mud: [[-3819, -1974, 49], [-3014, -1542, 46], [-2275, -1001, 57], [-1172, 488, 45], [2149, 1452, 45], [3911, 1651, 46]],
      rocks: [[-3370, -1331, 33], [-2888, -920, 35], [-1890, -1060, 30], [-2036, -134, 33], [-1101, 905, 27], [-357, 453, 40], [1030, 964, 27], [1354, 1183, 31], [3078, 1601, 28], [4392, 1692, 27]]
    },
    {
      /* 衝刺賽道：open ＝ 起點到終點，沒有圈數。canyonrun seed=canyonrun-0 長度 10360 節點 740 路寬 226 半徑 min 245/p2 265 全程 60.2s 葉 21 */
      id: 'canyonrun', name: '峽谷長征', theme: 'canyon', stars: 4, laps: 1, open: true,
      desc: '峽谷裡的單程長征，沒有圈數。一個閃神就是一面石壁。',
      startNode: 0, itemCount: 14,
      ctrl: [
        [-4165, 465, 102], [-3849, 412, 112], [-3594, 605, 107], [-3387, 849, 97], [-3068, 815, 111],
        [-2757, 890, 99], [-2469, 752, 103], [-2269, 501, 110], [-1949, 505, 114], [-1645, 602, 102],
        [-1330, 658, 101], [-1026, 758, 104], [-721, 661, 110], [-490, 439, 98], [-236, 244, 113],
        [-34, -3, 91], [240, -170, 112], [418, -435, 95], [738, -434, 103], [1058, -437, 98],
        [1326, -261, 105], [1602, -99, 104], [1876, 67, 95], [2165, -71, 91], [2483, -102, 102],
        [2783, -214, 103], [3103, -216, 95], [3364, -402, 101], [3650, -545, 99], [3952, -651, 107],
        [4165, -890, 103]
      ],
      boosts: [[-4114, 517, 61], [-2524, 609, 58], [691, -485, 61], [1560, -222, 54], [4162, -651, 52]],
      mud: [[-3329, 893, 51], [-1612, 642, 44], [-725, 679, 55], [-20, 61, 53], [2394, -122, 43], [3321, -265, 55]],
      rocks: [[-4488, 836, 32], [-2299, 193, 26], [-1732, 968, 33], [-1010, 1125, 37], [-733, 217, 39], [645, -168, 32], [2716, -423, 30], [3320, -535, 41], [3884, -862, 24]]
    },
    {
      /* 衝刺賽道：open ＝ 起點到終點，沒有圈數。snowrun seed=snowrun-1 長度 10136 節點 724 路寬 224 半徑 min 243/p2 348 全程 52.4s 葉 25 */
      id: 'snowrun', name: '雪原長征', theme: 'snow', stars: 4, laps: 1, open: true,
      desc: '雪原上的單程長征，沒有圈數。路滑、彎又多，穩比快重要。',
      startNode: 0, itemCount: 14,
      ctrl: [
        [-4050, 487, 90], [-3780, 660, 105], [-3462, 693, 112], [-3167, 568, 105], [-2847, 572, 102],
        [-2531, 624, 92], [-2226, 529, 92], [-1964, 344, 94], [-1755, 102, 94], [-1596, -175, 105],
        [-1433, -451, 113], [-1126, -539, 111], [-852, -374, 91], [-662, -117, 95], [-502, 161, 104],
        [-343, 439, 91], [-23, 439, 103], [281, 341, 92], [544, 158, 109], [828, 11, 106],
        [1098, -161, 101], [1337, -373, 108], [1656, -401, 112], [1973, -442, 106], [2280, -535, 95],
        [2558, -693, 91], [2867, -608, 104], [3119, -411, 96], [3436, -371, 113], [3731, -495, 113],
        [4050, -524, 112]
      ],
      boosts: [[-2174, 430, 52], [-1642, -298, 53], [-893, -373, 50], [-407, 393, 57], [2051, -465, 59], [2910, -698, 52], [3739, -431, 52]],
      mud: [[-3923, 749, 55], [-3034, 657, 52], [415, 240, 45], [1169, -253, 54]],
      rocks: [[-3148, 927, 24], [-1340, -103, 40], [-1055, -840, 25], [-465, -262, 26], [358, 688, 42], [1850, -760, 30], [2616, -374, 27], [3263, -920, 33]]
    },
    {
      /* 衝刺賽道：open ＝ 起點到終點，沒有圈數。candyrun seed=candyrun-0 長度 10164 節點 726 路寬 228 半徑 min 420/p2 481 全程 56.7s 葉 23 */
      id: 'candyrun', name: '糖果長廊', theme: 'candy', stars: 3, laps: 1, open: true,
      desc: '一路穿過糖果長廊到終點，沒有圈數。葉子多，道具戰打得最兇。',
      startNode: 0, itemCount: 14,
      ctrl: [
        [-4816, -743, 104], [-4511, -618, 107], [-4194, -525, 99], [-3916, -348, 112],
        [-3602, -246, 93], [-3301, -111, 98], [-2980, -35, 112], [-2651, -63, 106],
        [-2382, -254, 97], [-2088, -404, 99], [-1760, -361, 107], [-1436, -302, 100],
        [-1108, -338, 94], [-784, -271, 110], [-487, -128, 98], [-194, 24, 113], [121, 120, 93],
        [445, 54, 98], [775, 53, 95], [1092, 143, 115], [1407, 241, 94], [1680, 427, 116],
        [1966, 592, 97], [2289, 658, 95], [2617, 619, 113], [2923, 743, 115], [3243, 662, 99],
        [3527, 495, 106], [3856, 471, 112], [4172, 378, 110], [4502, 396, 103], [4816, 296, 106]
      ],
      boosts: [[-4383, -583, 49], [-3539, -215, 51], [-50, 74, 60], [864, 78, 54], [4362, 388, 59]],
      mud: [[-2663, -113, 52], [-1807, -384, 43], [-883, -340, 51], [1707, 438, 51], [2582, 646, 51], [3432, 490, 48]],
      rocks: [[-1296, -631, 29], [25, -267, 40], [1531, 706, 40], [4045, 59, 38], [4626, 42, 26]]
    },
    {
      /* 衝刺賽道：open ＝ 起點到終點，沒有圈數。nightrun seed=nightrun-3 長度 9534 節點 681 路寬 238 半徑 min 444/p2 507 全程 49.5s 葉 24 */
      id: 'nightrun', name: '星空長征', theme: 'starry', stars: 3, laps: 1, open: true,
      desc: '星空下的單程長征，沒有圈數。跑到最後一段天會更暗，全靠路面的光。',
      startNode: 0, itemCount: 14,
      ctrl: [
        [-4460, -713, 106], [-4156, -585, 118], [-3851, -460, 113], [-3547, -331, 101],
        [-3217, -323, 112], [-2910, -200, 120], [-2635, -17, 109], [-2353, 153, 105],
        [-2105, 371, 120], [-1784, 447, 100], [-1454, 436, 106], [-1125, 460, 113], [-817, 577, 99],
        [-509, 697, 112], [-179, 713, 102], [127, 590, 103], [456, 562, 109], [764, 679, 104],
        [1089, 620, 107], [1412, 553, 108], [1727, 455, 111], [2018, 299, 118], [2275, 92, 100],
        [2514, -136, 104], [2840, -184, 107], [3166, -236, 105], [3480, -135, 121], [3802, -61, 108],
        [4132, -46, 102], [4460, -15, 99]
      ],
      boosts: [[-2503, 61, 51], [-1760, 442, 49], [-919, 536, 61], [-99, 678, 58], [727, 654, 60], [1563, 509, 61], [3061, -221, 56]],
      mud: [[-4079, -536, 43], [-3254, -366, 51], [2283, 69, 48], [3891, -10, 56]],
      rocks: [[-2613, -445, 38], [-1263, 803, 34], [1735, 789, 28], [2685, 137, 40], [3149, 103, 28]]
    }
,
    /* ================= 城市 =================
     * 路外不是草地而是水泥人行道（見 themes 的 city／highway／cityNight），
     * 兩側的大樓、路燈、三角錐在 render.js 的 building／lamp／cone。
     * 三張有圈數、兩張是衝刺。 */
    {
      id: 'downtown', name: '市中心環線', theme: 'city', stars: 2, laps: 2,
      desc: '繞著市中心的街廓跑，長短直線交替，路口多但路面夠寬，是城市裡最好上手的一張。',
      startNode: 0, itemCount: 13,
      ctrl: [
        [133, 321, 100], [377, 329, 82], [563, 264, 96], [617, 160, 98],
        [624, 69, 98], [690, -11, 91], [762, -111, 85], [698, -212, 102],
        [487, -264, 79], [255, -269, 101], [69, -283, 83], [-133, -321, 82],
        [-377, -329, 103], [-563, -264, 83], [-617, -160, 80], [-624, -69, 92],
        [-690, 11, 100], [-762, 111, 104], [-698, 212, 107], [-487, 264, 79],
        [-255, 269, 108], [-69, 283, 102]
      ],
      boosts: [[420, 280, 52], [-620, -180, 50], [180, -240, 48]],
      mud: [[-300, 250, 42], [520, -120, 40]],
      rocks: [[0, 40, 150], [900, 520, 44], [-980, -560, 46]]
    },
    {
      id: 'oldtown', name: '舊城巷弄', theme: 'city', stars: 4, laps: 2,
      desc: '老城區的窄巷，一個彎接一個彎，幾乎沒有直線 —— 城市裡最難的一張。',
      startNode: 0, itemCount: 11,
      ctrl: [
        [-249, -483, 97], [-162, -491, 100], [-81, -422, 82], [-59, -352, 87],
        [-69, -340, 80], [-47, -269, 99], [-24, -250, 83], [49, -241, 101],
        [59, -253, 96], [132, -244, 81], [196, -190, 98], [214, -114, 84],
        [202, -100, 99], [219, -24, 82], [281, 27, 87], [358, 31, 84],
        [370, 17, 101], [448, 21, 79], [511, 74, 86], [519, 162, 100],
        [483, 204, 94], [479, 282, 88], [492, 293, 103], [488, 371, 101],
        [435, 434, 94], [359, 452, 85], [346, 440, 84], [270, 458, 96],
        [249, 483, 98], [162, 491, 81], [9, 363, 79], [-12, 291, 91],
        [-2, 279, 94], [-23, 208, 78], [-49, 187, 96], [-122, 178, 89],
        [-133, 190, 91], [-206, 182, 81], [-237, 156, 85], [-254, 80, 88],
        [-243, 66, 101], [-260, -10, 92], [-314, -55, 99], [-392, -59, 80],
        [-403, -45, 81], [-481, -49, 86], [-511, -74, 86], [-519, -162, 87],
        [-476, -213, 89], [-471, -289, 83], [-484, -301, 80], [-479, -377, 79],
        [-446, -417, 83], [-371, -435, 104], [-358, -424, 91], [-283, -442, 86]
      ],
      boosts: [[380, 320, 46], [-420, -260, 46]],
      mud: [[240, -300, 40], [-360, 280, 40]],
      rocks: [[0, 0, 130], [820, 480, 40], [-860, -500, 42]]
    },
    {
      /* 使用者指定：高速公路，兩圈 */
      id: 'expressway', name: '都會高速公路', theme: 'highway', stars: 3, laps: 2,
      desc: '又寬又長的高架快速道路，直線一條接一條，全場最高速的一張 —— 跑兩圈。',
      startNode: 0, itemCount: 15,
      ctrl: [
        [506, 206, 106], [371, 279, 78], [146, 316, 100], [-99, 300, 88],
        [-287, 244, 92], [-407, 182, 79], [-515, 132, 101], [-660, 87, 98],
        [-816, 26, 87], [-892, -57, 102], [-822, -140, 101], [-625, -193, 83],
        [-390, -211, 79], [-189, -214, 81], [-15, -227, 108], [184, -249, 92],
        [427, -257, 84], [658, -223, 93], [787, -149, 102], [780, -63, 102],
        [690, 11, 87], [606, 69, 105], [562, 131, 100]
      ],
      boosts: [[150, 310, 58], [-700, 60, 56], [400, -250, 58], [760, -120, 54]],
      mud: [[-400, -205, 44]],
      rocks: [[0, 20, 170], [1050, 600, 46], [-1120, -640, 48]]
    },
    {
      id: 'bayrun', name: '濱海快速道路', theme: 'highway', stars: 2, laps: 1, open: true,
      desc: '沿著海灣從城西開到城東，沒有圈數 —— 一路長彎與長直線，先到終點的贏。',
      startNode: 0, itemCount: 16,
      ctrl: [
        [-3400, 205, 125], [-3166, 421, 120], [-2931, 458, 129], [-2697, 520, 127],
        [-2462, 469, 115], [-2228, 394, 114], [-1993, 402, 131], [-1759, 318, 133],
        [-1524, 354, 107], [-1290, 414, 118], [-1055, 494, 117], [-821, 539, 133],
        [-586, 462, 124], [-352, 234, 128], [-117, 81, 118], [117, -252, 130],
        [352, -556, 127], [586, -638, 128], [821, -769, 121], [1055, -747, 125],
        [1290, -784, 114], [1524, -639, 114], [1759, -422, 126], [1993, -182, 129],
        [2228, -148, 123], [2462, -20, 128], [2697, 66, 129], [2931, 26, 129],
        [3166, 73, 114], [3400, 150, 112]
      ],
      boosts: [[-2400, 470, 56], [-500, 460, 54], [1300, -780, 56], [2700, 70, 54]],
      mud: [[-1300, 415, 44], [1750, -420, 44]],
      rocks: [[-2000, 900, 46], [600, -1100, 48], [2300, 500, 44]]
    },
    {
      id: 'nightst', name: '夜間街道', theme: 'cityNight', stars: 3, laps: 1, open: true,
      desc: '打烊後的街道，只有路燈跟招牌還亮著。彎比濱海那條多，路也窄一點。',
      startNode: 0, itemCount: 15,
      ctrl: [
        [-3100, 148, 86], [-2912, 455, 91], [-2724, 501, 98], [-2536, 469, 104],
        [-2348, 326, 93], [-2161, 435, 89], [-1973, 426, 92], [-1785, 392, 91],
        [-1597, 443, 95], [-1409, 267, 101], [-1221, 91, 90], [-1033, -143, 106],
        [-845, -530, 94], [-658, -696, 86], [-470, -753, 103], [-282, -701, 88],
        [-94, -464, 103], [94, -238, 88], [282, -111, 105], [470, 72, 107],
        [658, 57, 100], [845, 135, 94], [1033, 174, 86], [1221, 362, 94],
        [1409, 613, 95], [1597, 700, 99], [1785, 620, 92], [1973, 505, 99],
        [2161, 247, 100], [2348, -174, 90], [2536, -420, 87], [2724, -465, 91],
        [2912, -522, 99], [3100, -376, 90]
      ],
      boosts: [[-2500, 480, 50], [-300, 330, 48], [1500, -520, 50], [2600, 120, 48]],
      mud: [[-1400, 300, 40], [900, -380, 42]],
      rocks: [[-1800, 800, 42], [400, -900, 44], [2100, 600, 42]]
    }
  ];

  /* 選賽道畫面的分頁：依背景主題歸成幾大類。
   * 賽道一多，一排排全攤開會把整頁撐得很長，分頁之後一次只看一類。 */
  const GROUPS = [
    { id: 'all', name: '全部' },
    { id: 'garden', name: '花園', themes: ['garden', 'veggie', 'bloom'] },
    { id: 'forest', name: '森林', themes: ['branch', 'shroom'] },
    { id: 'water', name: '水邊', themes: ['pond', 'beach'] },
    { id: 'wild', name: '荒野', themes: ['canyon', 'snow', 'volcano'] },
    { id: 'sweet', name: '甜夢', themes: ['candy', 'starry'] },
    { id: 'city', name: '城市', themes: ['city', 'highway', 'cityNight'] },
    { id: 'random', name: '隨機' }
  ];

  /** 這張賽道屬於哪個分頁（隨機賽道自己一頁） */
  function groupOf(def) {
    if (!def) return 'all';
    if (def.id === 'random') return 'random';
    for (const g of GROUPS) if (g.themes && g.themes.indexOf(def.theme) >= 0) return g.id;
    return 'all';
  }

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
    SURFACE, SURFACE_MAX, CELL, NODE_STEP, CHECKPOINTS, START_STRAIGHT_NODES, START_LANE_GAP,
    TRACKS, BY_ID, build, get, list, randomDef, SHAPES, SHAPE_NAME, GROUPS, groupOf,
    surfaceAt, nodeAt, checkpointOf, lateralOf, sample, addTangents, idx
  };
});
