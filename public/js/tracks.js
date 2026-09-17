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

    /* 依距離重新取樣：讓每個節點間隔固定，進度計算才準 */
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
    /* 閉環時，如果最後一個節點離起點太近就砍掉，避免重複 */
    if (closed && nodes.length > 2) {
      const f = nodes[0], l = nodes[nodes.length - 1];
      if (Math.hypot(l.x - f.x, l.y - f.y) < NODE_STEP * 0.5) nodes.pop();
    }
    return nodes;
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
  function build(def) {
    const nodes = addTangents(sample(def.ctrl, true), true);
    const shortcuts = (def.shortcuts || []).map(sc => ({
      nodes: addTangents(sample(sc.ctrl, false), false),
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
    for (const m of def.mud || []) paintBlob(grid, m[0], m[1], m[2], SURFACE.MUD);
    for (const b of def.boosts || []) paintBlob(grid, b[0], b[1], b[2], SURFACE.BOOST);

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

    /* 起跑格：終點線前方，依席位排成兩列交錯 */
    const startNode = def.startNode || 0;
    const grid0 = nodes[startNode];
    const starts = [];
    for (let s = 0; s < 8; s++) {
      const row = Math.floor(s / 2), col = s % 2;
      const back = -(row * 34 + 24);
      const side = (col === 0 ? -1 : 1) * grid0.w * 0.34;
      const nd = nodes[((startNode + Math.round(back / NODE_STEP)) % nodes.length + nodes.length) % nodes.length];
      starts.push({
        x: nd.x + nd.nx * side,
        y: nd.y + nd.ny * side,
        angle: Math.atan2(nd.ty, nd.tx),
        node: ((startNode + Math.round(back / NODE_STEP)) % nodes.length + nodes.length) % nodes.length
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
      nodes, shortcuts, grid, bounds, items, starts,
      rocks: (def.rocks || []).map(r => ({ x: r[0], y: r[1], r: r[2] })),
      mud: (def.mud || []).map(r => ({ x: r[0], y: r[1], r: r[2] })),
      boosts: (def.boosts || []).map(r => ({ x: r[0], y: r[1], r: r[2] })),
      checkpoints: CHECKPOINTS,
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
      const i = ((base + d) % n + n) % n;
      const dx = nodes[i].x - x, dy = nodes[i].y - y;
      const dist = dx * dx + dy * dy;
      if (dist < bestD) { bestD = dist; best = i; }
    }
    return best;
  }

  /** 節點 index → 檢查點 index */
  function checkpointOf(track, nodeIndex) {
    return Math.floor(nodeIndex / track.nodes.length * CHECKPOINTS) % CHECKPOINTS;
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
      desc: '寬敞好跑的入門賽道，彎道和緩，適合第一次玩。',
      startNode: 0, itemCount: 9,
      ctrl: [
        [0, -520, 96], [330, -470, 96], [520, -260, 92], [540, 40, 92],
        [430, 300, 88], [170, 430, 92], [-140, 450, 92], [-400, 330, 88],
        [-540, 90, 92], [-520, -230, 92], [-330, -460, 96]
      ],
      boosts: [[520, -110, 60], [-60, 445, 62], [-535, -70, 58]],
      mud: [[430, 300, 54]],
      rocks: [[0, 0, 150], [274, -668, 40], [-322, 574, 44]]
    },
    {
      id: 'veggie', name: '菜園迷宮', theme: 'veggie', stars: 2, laps: 3,
      desc: '菜畦之間的直角彎一個接一個，走線沒抓好就會撞牆。',
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
      id: 'branch', name: '大樹枝幹', theme: 'branch', stars: 3, laps: 3,
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
      id: 'pond', name: '水窪淺灘', theme: 'pond', stars: 2, laps: 3,
      desc: '雨後的淺灘，泥巴和水窪特別多，記得繞開深色的地方。',
      startNode: 0, itemCount: 12,
      ctrl: [
        [0, -500, 92], [300, -430, 90], [470, -200, 86], [380, 60, 84],
        [520, 280, 88], [260, 460, 90], [-60, 470, 88], [-330, 380, 86],
        [-260, 120, 82], [-500, -60, 86], [-460, -330, 90], [-230, -490, 92]
      ],
      boosts: [[430, -330, 52], [80, 470, 54], [-480, -200, 50]],
      mud: [[430, -60, 62], [150, 465, 58], [-300, 250, 56], [-300, -10, 54], [-450, -420, 50]],
      rocks: [[0, 20, 140], [581, 475, 46]]
    },
    {
      id: 'candy', name: '糖果餅乾', theme: 'candy', stars: 3, laps: 3,
      desc: '長長的餅乾直線，是練蠕動衝刺最痛快的地方，但兩端的大彎很吃技術。',
      startNode: 0, itemCount: 10,
      ctrl: [
        [-620, -300, 86], [0, -380, 90], [620, -300, 86], [700, -60, 82],
        [560, 170, 84], [180, 120, 80], [-180, 160, 80], [-560, 190, 84],
        [-700, -40, 82]
      ],
      boosts: [[-300, -355, 58], [300, -355, 58], [370, 140, 54], [-370, 175, 54]],
      mud: [[0, 140, 52]],
      rocks: [[0, -110, 120], [-661, 333, 54], [660, 330, 54]]
    },
    {
      id: 'shroom', name: '夜光蘑菇', theme: 'shroom', stars: 4, laps: 3,
      desc: '夜裡的蘑菇森林，路窄、彎急、捷徑多，是最難的一張。',
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
  ];

  const BY_ID = {};
  for (const t of TRACKS) BY_ID[t.id] = t;

  /* ---------- 隨機賽道 ---------- */

  /**
   * 用極座標擾動生成一個閉環：先取 9～12 個角度均分的點，
   * 每個點的半徑在合理範圍內抖動，再檢查相鄰半徑差距不要太誇張，
   * 這樣 Catmull-Rom 平滑之後一定閉合、不自交、曲率也不會小到轉不過去。
   */
  function randomDef(seed) {
    const rng = RNG.create(seed);
    const n = rng.int(9, 12);
    const baseR = rng.range(430, 560);
    const radii = [];
    for (let i = 0; i < n; i++) radii.push(baseR * rng.range(0.72, 1.3));
    /* 相鄰半徑差太大會出現尖角，壓平一輪 */
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < n; i++) {
        const a = radii[(i - 1 + n) % n], b = radii[(i + 1) % n];
        radii[i] = radii[i] * 0.6 + (a + b) * 0.2;
      }
    }
    const rot = rng.range(0, Math.PI * 2);
    const ctrl = [];
    for (let i = 0; i < n; i++) {
      const a = rot + (i / n) * Math.PI * 2;
      const w = rng.range(58, 94);
      ctrl.push([Math.cos(a) * radii[i], Math.sin(a) * radii[i] * 0.86, w]);
    }

    /* 加速帶、泥巴、石頭都擺在控制點附近，確定落在跑道上或跑道外 */
    const boosts = [], mud = [], rocks = [[0, 0, Math.min(...radii) * 0.42]];
    for (let i = 0; i < n; i++) {
      const p = ctrl[i];
      if (rng.chance(0.42)) boosts.push([p[0] * 0.99, p[1] * 0.99, rng.range(40, 58)]);
      else if (rng.chance(0.38)) mud.push([p[0] * 0.99, p[1] * 0.99, rng.range(36, 54)]);
    }
    return {
      id: 'random', name: '隨機賽道', theme: rng.pick(['garden', 'veggie', 'pond', 'candy', 'shroom', 'branch']),
      desc: '每一局都不一樣的賽道。', stars: 3, laps: 3, random: true, seed: seed,
      startNode: 0, itemCount: 12, ctrl, boosts, mud, rocks
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
    SURFACE, CELL, NODE_STEP, CHECKPOINTS,
    TRACKS, BY_ID, build, get, list, randomDef,
    surfaceAt, nodeAt, checkpointOf, lateralOf, sample, addTangents
  };
});
