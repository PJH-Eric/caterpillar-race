/* ===== ai.js — 四段電腦對手 =====
 *
 * 電腦跟真人跑同一套 rules.js，差別只在「看得多準」與「決定多快」：
 *   走線精度 lineErr、反應延遲 react、蠕動節奏 wiggle、閃避意識 avoid、速度上限 cap。
 * 只改名字不改行為的 AI 不算數，scripts/ai-check.js 會量四段的差異。
 *
 * 亂數用「每個 AI 自己的 rng」，不共用 state.rng ——
 * 不然 AI 多抖一次，別人抽到的道具就全部變了，重播與線上同步都會對不起來。
 */
(function (root, factory) {
  'use strict';
  const isNode = (typeof module === 'object' && module.exports);
  const RNG = isNode ? require('./rng.js') : root.RNG;
  const Tracks = isNode ? require('./tracks.js') : root.Tracks;
  const Rules = isNode ? require('./rules.js') : root.Rules;
  const api = factory(RNG, Tracks, Rules);
  if (isNode) module.exports = api;
  else root.AI = api;
})(typeof self !== 'undefined' ? self : this, function (RNG, Tracks, Rules) {
  'use strict';

  const D = Rules.DIFFICULTY;

  /* 操控參數集中在這裡，scripts/ai-check.js 可以掃描調校，不用到處翻程式碼 */
  const TUNE = {
    damp: 0.12,        /* 預判收舵：把「已經在轉的量」扣掉多少 */
    laBase: 80,        /* 看多遠的基礎距離（世界單位） */
    laSpeed: 0.62,     /* 每單位速度多看多遠 */
    laSkill: 0.20,     /* 技術越好多看多遠 */
    apexW: 0.95,       /* 內切的權重 */
    entryW: 0.80,      /* 入彎提早往外站的權重 */
    lineW: 0.52,       /* 理想線偏移佔半寬的比例 */
    calm: 0.65         /* 彎越兇越退回中線的程度 */
  };

  /** 每個 AI 的腦袋：只在 react 間隔重新想一次，其他時間沿用上次的決定 */
  function brainFor(state, r) {
    if (!state.ai) state.ai = {};
    let b = state.ai[r.id];
    if (!b) {
      b = state.ai[r.id] = {
        rng: RNG.create(state.seed + ':' + r.id),
        nextThink: 0,
        steer: 0,
        aim: 0,            /* 想要的橫向偏移 */
        wiggleDir: 1,
        wiggleNext: 0,
        wiggling: false,
        useAt: 0
      };
    }
    return b;
  }

  /** 看多遠（單位：節點數）。速度越快、技術越好就看越遠。 */
  function lookahead(r, skill) {
    return Math.round((TUNE.laBase + r.speed * (TUNE.laSpeed + TUNE.laSkill * skill)) / Tracks.NODE_STEP);
  }

  /** 賽道在某個節點的彎曲方向與程度：正＝往左彎，負＝往右彎 */
  function curvatureAt(track, index, span) {
    const n = track.nodes.length;
    const a = track.nodes[Tracks.idx(track, index - span)];
    const b = track.nodes[Tracks.idx(track, index + span)];
    /* 兩個切線的夾角（帶正負） */
    const cross = a.tx * b.ty - a.ty * b.tx;
    const dot = a.tx * b.tx + a.ty * b.ty;
    return Math.atan2(cross, dot);
  }

  /**
   * 想一次：決定這段時間要往哪邊轉、要不要用道具。
   */
  function think(state, r, b) {
    const track = state.track;
    const d = D[r.difficulty] || D.normal;
    const n = track.nodes.length;

    /* 看多遠：速度越快看越遠，技術越好也看越遠 */
    const skill = 1 - d.lineErr;
    const ahead = lookahead(r, skill);
    const idx = Tracks.idx(track, r.node + ahead);
    const nd = track.nodes[idx];

    /* 理想線是「外—內—外」，不是一路貼內側。
     *
     * 只算「前方的彎往哪邊」然後一路貼內側的話，因為這個遊戲沒有煞車，
     * 毛毛蟲會帶著全速滑出彎道 —— 實測普通與困難的出界 tick 比簡單還多，
     * 完成時間也反過來輸給簡單。現在同時看兩段：
     *   apex ：前方近處的彎 → 往內側切
     *   entry：更前面的彎   → 提早往外側站，把入彎角度拉開
     */
    const apex = curvatureAt(track, idx, Math.max(3, ahead));
    const entry = curvatureAt(track, Tracks.idx(track, r.node + ahead * 2), Math.max(4, ahead));
    const inside = c => Math.sign(c) * Math.min(1, Math.abs(c) * 1.6);
    /* 彎有多兇：彎度乘上現在的速度。這個遊戲沒有煞車，帶著全速進窄彎一定會滑出去。
     * 試過「越兇就擺得越外側」，結果四段全部變慢 —— 外側起步反而把滑出去的距離拉更長。
     * 改成越兇就越退回中線：中線兩邊都有餘裕，是窄彎裡唯一穩得住的走線。 */
    const severity = Math.min(1, Math.abs(entry) * r.speed / 240);
    let aim = (inside(apex) * TUNE.apexW - inside(entry) * TUNE.entryW) * nd.w * TUNE.lineW * skill * (1 - TUNE.calm * severity);

    /* 順路吃加速帶：偏移不大才值得繞 */
    let bestPad = null, bestPadD = Infinity;
    for (const p of track.boosts) {
      const dist = Math.hypot(p.x - nd.x, p.y - nd.y);
      if (dist < bestPadD && dist < nd.w * 1.6) { bestPadD = dist; bestPad = p; }
    }
    /* 只在前面那個彎不兇的時候才繞去吃加速帶。
     * 這遊戲沒有煞車，加速帶吃進窄彎等於直接飛出去 —— 困難的 AI 原本因為最愛吃加速帶，
     * 在夜光蘑菇那張反而比普通慢了 20 秒。 */
    if (bestPad && d.avoid > 0.3 && severity < 0.45) {
      const lat = (bestPad.x - nd.x) * nd.nx + (bestPad.y - nd.y) * nd.ny;
      aim = aim * 0.35 + lat * 0.65 * skill;
    }

    /* 閃泥巴與黏液 */
    const hazards = track.mud.concat(state.goo.map(g => ({ x: g.x, y: g.y, r: 24 })));
    for (const h of hazards) {
      const dist = Math.hypot(h.x - nd.x, h.y - nd.y);
      if (dist > h.r + 30) continue;
      const lat = (h.x - nd.x) * nd.nx + (h.y - nd.y) * nd.ny;
      /* 往危險物的反方向閃，閃多少看難度 */
      aim += -Math.sign(lat || 1) * Math.min(h.r + 20, nd.w * 0.45) * d.avoid;
    }

    /* 走線誤差：手殘的難度會亂飄 */
    aim += (b.rng.next() * 2 - 1) * nd.w * d.lineErr;
    const margin = Math.min(nd.w * 0.72, Math.max(0, nd.w - 18));
    aim = Rules.clamp(aim, -margin, margin);
    b.aim = aim;

    /* 決定道具 */
    b.wantUse = decideItem(state, r, d, b);

    /* 要不要開始蠕動衝刺：要看「前方一整段」都夠直才扭。
     * 只看腳下那一小段的話，衝刺會剛好在入彎時生效，直接把自己送去草地。 */
    /* 「前面夠直嗎」要用固定的檢查長度。
     * 看得遠的參數調大之後，ahead 可以到 19 個節點，乘二就是 530 個世界單位，
     * 這麼長一段幾乎沒有賽道是直的 —— 結果四段 AI 的蠕動衝刺全變成 0。 */
    const span = Math.min(ahead, 14);
    /* 附近有石頭就不扭。扭動會讓車頭左右各偏幾度，
     * 貼著石頭扭一下就是一次撞牆 —— 困難的 AI 原本因此多撞了二十幾次。 */
    let rockNear = false;
    for (const rk of track.rocks) {
      if (Math.hypot(rk.x - nd.x, rk.y - nd.y) < rk.r + nd.w + 40) { rockNear = true; break; }
    }
    const straight = !rockNear
      && Math.abs(curvatureAt(track, Tracks.idx(track, r.node + span), span)) < 0.18
      && severity < 0.40;
    b.wiggling = straight && b.rng.next() < d.wiggle;

    b.nextThink = state.t + d.react * (0.6 + b.rng.next() * 0.8);
  }

  function decideItem(state, r, d, b) {
    if (!r.item) return false;
    if (state.t < b.useAt) return false;
    const id = r.item;

    if (id === 'juice') {
      /* 直線或已經被拖慢時喝，笨一點的就隨便喝 */
      const straight = Math.abs(curvatureAt(state.track, r.node, 10)) < 0.25;
      return straight || state.t < r.slowUntil || b.rng.next() < 0.25 + d.lineErr;
    }
    if (id === 'hop') {
      const surface = Tracks.surfaceAt(state.track, r.x, r.y);
      return surface !== Tracks.SURFACE.TRACK || b.rng.next() < 0.2;
    }
    if (id === 'shield') {
      /* 有人在附近就先開泡泡，不然放著等 */
      for (const o of state.racers) {
        if (o.id === r.id || o.ghost || o.finished) continue;
        const gap = (r.progress - o.progress) * Tracks.NODE_STEP;
        if (gap > 0 && gap < 500 && o.item) return b.rng.next() < 0.5 + d.avoid * 0.5;
      }
      return b.rng.next() < 0.08;
    }
    if (id === 'goo') {
      for (const o of state.racers) {
        if (o.id === r.id || o.ghost || o.finished) continue;
        const gap = (r.progress - o.progress) * Tracks.NODE_STEP;
        if (gap > 30 && gap < 700) return true;
      }
      return b.rng.next() < 0.05;
    }
    if (id === 'web') {
      return !!Rules.nearestAhead(state, r, 900);
    }
    if (id === 'tiny') {
      return r.rank > 1;
    }
    return false;
  }

  /**
   * 產生這個 tick 的輸入。
   * @returns {{steer:number, use:boolean}}
   */
  function input(state, r) {
    const d = D[r.difficulty] || D.normal;
    const b = brainFor(state, r);
    if (state.t >= b.nextThink) think(state, r, b);

    const track = state.track;
    const n = track.nodes.length;
    const ahead = lookahead(r, 1 - d.lineErr);
    const nd = track.nodes[Tracks.idx(track, r.node + ahead)];

    /* 目標點＝前方節點沿法線偏移 aim */
    const tx = nd.x + nd.nx * b.aim;
    const ty = nd.y + nd.ny * b.aim;
    let want = Math.atan2(ty - r.y, tx - r.x) - r.angle;
    while (want > Math.PI) want -= Math.PI * 2;
    while (want < -Math.PI) want += Math.PI * 2;

    /* 轉向有慣性，所以不能只看「還差幾度」就猛打方向 ——
     * 那樣一定會轉過頭再轉回來，一路蛇行。把「現在已經在轉的量」先扣掉，
     * 等於提早收舵，這是最基本的 PD 控制。 */
    const DEAD = 0.045;
    const err = want - r.turnVel * TUNE.damp;
    let steer = err > DEAD ? 1 : (err < -DEAD ? -1 : 0);

    /* 蠕動衝刺：進入扭動狀態後就「整段」照節奏交替，不讓每個 tick 的方向修正插隊。
     *
     * 第一版寫成「steer 等於 0 時才扭」，扭一下之後方向誤差立刻變大，
     * 下一個 tick 又被修正搶回去 —— 換向間隔變成一個 tick（0.033 秒），
     * 落在「亂按」區間，蠕動槽永遠歸零，四段 AI 的衝刺次數全是 0。
     * 現在只要方向誤差還在容忍範圍內就維持節奏，超過才放棄這次扭動。 */
    const WIG_KEEP = 0.38;
    if (b.wiggling && !r.finished && Math.abs(want) < WIG_KEEP) {
      if (state.t >= b.wiggleNext) {
        b.wiggleDir = -b.wiggleDir;
        /* 技術越好，節奏越靠近甜蜜區間中央 */
        const jitter = (1 - d.wiggle) * 0.30;
        b.wiggleNext = state.t + 0.26 + (b.rng.next() * 2 - 1) * jitter;
      }
      steer = b.wiggleDir;
    } else {
      b.wiggleNext = 0;
    }

    /* 幼幼班的體貼：玩家落後太多就放慢等人（規劃書 §5）。
     * 用 capScale 直接縮速度上限，不用「刻意走草地」那種會讓毛毛蟲原地打轉的髒招。 */
    r.capScale = 1;
    if (d.mercy) {
      const human = state.racers.find(o => o.kind === 'human' && !o.ghost);
      if (human) {
        const lead = (r.progress - human.progress) * Tracks.NODE_STEP;
        if (lead > track.length * 0.25) r.capScale = 0.62;
        else if (lead > track.length * 0.12) r.capScale = 0.82;
      }
    }

    const use = !!b.wantUse;
    if (use) { b.wantUse = false; b.useAt = state.t + 0.4; }
    return { steer, use };
  }

  /** 一次幫所有電腦對手產生輸入 */
  function inputsFor(state) {
    const out = {};
    for (const r of state.racers) {
      if (r.kind !== 'ai' || r.finished || r.ghost) continue;
      out[r.id] = input(state, r);
    }
    return out;
  }

  return { input, inputsFor, curvatureAt, brainFor, lookahead, TUNE };
});
