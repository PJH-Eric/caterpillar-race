/* ===== rules.js — 共用規則核心 =====
 *
 * 單機、電腦對手、線上三種模式跑的是這一份，不另寫會漂移的第二份。
 * 瀏覽器用 <script> 載入，伺服器直接 require('./public/js/rules.js')。
 *
 * 這支只做「確定性的模擬」：給定同一個 seed、同一串輸入、同樣的 dt，
 * 一定得到同樣的結果。畫面、聲音、網路、儲存都不在這裡。
 */
(function (root, factory) {
  'use strict';
  const isNode = (typeof module === 'object' && module.exports);
  const RNG = isNode ? require('./rng.js') : root.RNG;
  const Tracks = isNode ? require('./tracks.js') : root.Tracks;
  const Items = isNode ? require('./items.js') : root.Items;
  const api = factory(RNG, Tracks, Items);
  if (isNode) module.exports = api;
  else root.Rules = api;
})(typeof self !== 'undefined' ? self : this, function (RNG, Tracks, Items) {
  'use strict';

  const S = Tracks.SURFACE;

  /* ---------- 常數 ---------- */

  const C = {
    /* 模擬 */
    TICK: 1 / 30,              /* 權威迴圈頻率，前端預測也用同一個步長 */
    COUNTDOWN: 3.0,            /* 開跑前倒數 */
    FINISH_GRACE: 10.0,        /* 第一名完賽後，其他人還有 10 秒可以衝線 */

    /* 車體 */
    BODY_R: 11,                /* 碰撞半徑 */
    SEG: 7,                    /* 身體節數（畫面用，也決定黏液擺放距離） */
    SEG_GAP: 9,

    /* 速度 */
    BASE_SPEED: 150,           /* 跑道上的基礎速度（單位／秒）。按住前進就是這個速度。
                                * 175 直線衝太快，畫面流過去的速度會讓人暈；150 一圈慢約 16%。
                                * 注意這個值調慢，低速轉向反而更快（TURN_SPEED_FALLOFF），
                                * head 模式的鏡頭限速就是在擋這個。 */
    ACCEL: 450,
    BRAKE: 1050,               /* 目標比現在慢時，掉速比加速快 */
    GAS_UP: 1.0,               /* 鍵盤「上」：按住就是基礎速度，不再額外加成 */
    GAS_DOWN: -0.34,           /* 鍵盤「下」：煞停之後慢慢倒退 */
    MAX_BOOST: 0.95,           /* 所有加速加起來的上限 */

    /* 轉向 */
    TURN: 3.15,                /* 低速時的最大角速度（弧度／秒） */
    TURN_SPEED_FALLOFF: 0.25,  /* 越快越轉不動。0.42 太重，高速時根本轉不過彎 */
    TURN_PENALTY: 0.12,        /* 轉向中的速度懲罰上限 */
    /* 轉向慣性：毛毛蟲要花時間才把身體彎過去，不是按下去就瞬間滿舵。
     * 點一下只會畫出小小的 S 形，持續按住才轉得動彎道。 */
    TURN_ACCEL: 8.5,           /* 角加速度（弧度／秒²），約 0.22 秒到滿舵 */
    TURN_RELEASE: 11.0,        /* 放開之後回正比較快，免得鬆手還在飄 */

    /* 抓地力：每秒剩下多少橫向速度。越小越黏，越大越滑。
     * 水坑 0.30 比草地還滑 —— 水坑的懲罰是「會滑出去」，不是「變慢」，
     * 這樣它跟泥巴才是兩種不同的東西，不是換個顏色的泥巴。
     * 坡不改抓地力，坡就是純粹的速度。 */
    GRIP: { 0: 0.10, 1: 0.02, 2: 0.03, 3: 0.02, 4: 0.30, 5: 0.02, 6: 0.02 },

    /* 地形速度係數（index＝Tracks.SURFACE）
     * 0 草地 1 跑道 2 泥巴 3 加速帶 4 水坑 5 上坡 6 下坡
     * 水坑比泥巴好過一點（0.62 vs 0.45），痛的是它會打滑，看 GRIP。
     *
     * 上下坡的倍率是對稱的（-28% / +28%），但跑起來「一對坡」是淨扣時間的：
     * 上下坡的距離一樣，可是慢的那段待得久、快的那段一下就過去了，
     * 平均速度是調和平均 2/(1/0.72+1/1.28)＝0.92，不是算術平均的 1.00。
     * 這是對的 —— 真實的坡本來就這樣，而且這讓「爬坡」真的是個代價。
     * 要讓一對坡淨零的話下坡得開到 1.64，那個速度進彎會直接飛出去。 */
    SURFACE_SPEED: { 0: 0.65, 1: 1.0, 2: 0.45, 3: 1.0, 4: 0.62, 5: 0.72, 6: 1.28 },

    /* 加速帶 */
    PAD_TIME: 1.5,
    PAD_POWER: 0.60,

    /* 碰撞 */
    WALL_KEEP: 0.35,           /* 撞牆後速度剩多少 */
    BUMP_KEEP: 0.80,           /* 撞到其他毛毛蟲後速度剩多少 */

    /* 道具 */
    LEAF_R: 26,                /* 撿道具葉的判定半徑 */
    LEAF_RESPAWN: 8.0,
    GOO_R: 22,
    ITEM_COOLDOWN: 0.35        /* 用完道具到能再撿的間隔，避免同一 tick 連撿 */
  };

  /* 四段難度。差別在速度上限、走線精度、反應延遲與閃避意識，不是只改名字。 */
  const DIFFICULTY = {
    baby:   { id: 'baby',   name: '幼幼班', cap: 0.78, lineErr: 0.55, react: 2.2, avoid: 0.0,  useBad: false, mercy: true },
    easy:   { id: 'easy',   name: '簡單',   cap: 0.86, lineErr: 0.34, react: 1.2, avoid: 0.15, useBad: true,  mercy: false },
    normal: { id: 'normal', name: '普通',   cap: 0.95, lineErr: 0.16, react: 0.5, avoid: 0.55, useBad: true,  mercy: false },
    hard:   { id: 'hard',   name: '困難',   cap: 1.00, lineErr: 0.10, react: 0.15, avoid: 0.90, useBad: true,  mercy: false }
  };
  const DIFFICULTY_LIST = ['baby', 'easy', 'normal', 'hard'];

  /* ---------- 小工具 ---------- */

  function moveToward(v, target, rate) {
    if (v < target) return Math.min(target, v + rate);
    return Math.max(target, v - rate);
  }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /* ---------- 建立一局 ---------- */

  /** 起跑席位由中央向左右展開，每局用種子隨機分配給選手。 */
  function centerOutStartSlots(count, rng) {
    const order = [];
    const left = Math.floor((count - 1) / 2);
    const right = Math.ceil((count - 1) / 2);
    for (let distance = 0; order.length < count; distance++) {
      const pair = [];
      const a = left - distance;
      const b = right + distance;
      if (a >= 0) pair.push(a);
      if (b < count && b !== a) pair.push(b);
      if (distance === 0) rng.shuffle(pair);
      order.push(...pair);
    }
    return order;
  }

  /**
   * @param {object} opt
   *   track     Tracks.get() 產出的賽道
   *   racers    [{ id, name, char, kind:'human'|'ai', difficulty }]
   *   laps      圈數（不給就用賽道預設）
   *   seed      亂數種子
   *   allowBad  是否開放負面道具
   */
  function createRace(opt) {
    const track = opt.track;
    const laps = opt.laps || track.laps;
    const seed = opt.seed || RNG.newSeed();
    const N = track.nodes.length;
    const startRng = RNG.create(seed + ':starts');
    const startSlots = centerOutStartSlots(track.starts.length, startRng);
    const racerList = opt.racers || [];
    /* 線上全員都是玩家時打散座位，單機保留玩家與 AI 的難度順序，避免 AI
     * 因為換到不同橫向位置而在某些彎道卡住。 */
    const allHuman = racerList.every(r => (r.kind || 'human') === 'human');
    const racerOrder = allHuman
      ? startRng.shuffle(Array.from({ length: racerList.length }, (_, i) => i))
      : Array.from({ length: racerList.length }, (_, i) => i);
    const racerSlots = [];
    for (let i = 0; i < racerOrder.length; i++) racerSlots[racerOrder[i]] = startSlots[i % startSlots.length];

    const racers = racerList.map((r, i) => {
      const slot = racerSlots[i];
      const start = track.starts[slot];
      return {
        id: r.id,
        name: r.name || ('毛毛蟲' + (i + 1)),
        char: r.char || 'lime',
        kind: r.kind || 'human',
        difficulty: r.difficulty || 'normal',
        seat: i,

        x: start.x, y: start.y, angle: start.angle,
        vx: 0, vy: 0, speed: 0,
        turnVel: 0,              /* 現在的角速度，有慣性 */

        node: start.node,
        cp: Tracks.checkpointOf(track, start.node),
        /* 累計通過的檢查點數，圈數由它算出來；起跑時八隻並排在線上，從零開始。 */
        cpCount: 0,
        lap: 0,
        started: false,          /* 開跑後開始計第一圈 */
        lapStart: 0,
        lapTimes: [],
        progress: 0,             /* 排名用的累積進度 */
        rank: i + 1,
        finished: false,
        finishTime: 0,

        padUntil: 0,
        juiceUntil: 0,
        slowUntil: 0, slowPower: 0,
        shieldUntil: 0,
        hopUntil: 0,
        tinyUntil: 0,

        item: null,
        itemReadyAt: 0,

        capScale: 1,             /* 幼幼班電腦在玩家落後太多時會放慢 */
        ghost: false,            /* 掉線時幽靈化：半透明、不參與碰撞 */
        connected: true,
        disconnectedAt: 0,

        surface: S.TRACK,        /* 上一 tick 踩在什麼地形（用來抓「剛踏進水坑」那一刻） */
        stats: { hits: 0, pads: 0, itemsUsed: 0, itemHits: 0, offTrack: 0, splash: 0, downhill: 0 }
      };
    });

    const leaves = track.items.map(it => ({ x: it.x, y: it.y, node: it.node, readyAt: 0 }));

    return {
      seed,
      rng: RNG.create(seed),
      track,
      laps,
      allowBad: opt.allowBad !== false,
      trackNodes: N,

      t: 0,                      /* 含倒數的總時間 */
      raceT: 0,                  /* 開跑之後的比賽時間 */
      phase: 'countdown',        /* countdown → racing → finished */
      firstFinishAt: 0,
      graceEnd: 0,               /* 第一名完賽後，收局的時間點 */

      racers,
      leaves,
      goo: [],
      webs: [],                  /* 只是給畫面畫一下的蜘蛛絲，不影響模擬 */
      events: []                 /* 這一 tick 發生的事，畫面與音效自己撈 */
    };
  }

  /* ---------- 速度與地形 ---------- */

  function surfaceFor(state, r) {
    /* 葉子小飛期間飄在空中，什麼地形都踩不到 */
    if (state.t < r.hopUntil) return S.TRACK;
    return Tracks.surfaceAt(state.track, r.x, r.y);
  }

  function speedFactor(state, r, surface, steer, gas, man) {
    const d = DIFFICULTY[r.difficulty] || DIFFICULTY.normal;
    let f = C.SURFACE_SPEED[surface];

    /* 果汁加速期間不怕減速地形（草地、泥巴、水坑、上坡都當作一般路面） */
    if (state.t < r.juiceUntil && f < 1) f = 1;

    let boost = 0;
    if (state.t < r.juiceUntil) boost += Items.ITEMS.juice.power;
    if (state.t < r.padUntil) boost += C.PAD_POWER;
    f *= (1 + Math.min(C.MAX_BOOST, boost));

    if (state.t < r.slowUntil) f *= (1 - r.slowPower);
    if (state.t < r.tinyUntil) f *= (1 - Items.ITEMS.tiny.power);

    /* 轉向懲罰：越快轉越痛 */
    const ratio = clamp(r.speed / C.BASE_SPEED, 0, 1.6);
    if (steer) f *= (1 - C.TURN_PENALTY * Math.min(1, ratio));

    /* 電腦對手的速度上限；真人一律 1.0。capScale 給幼幼班的「等一下玩家」用。 */
    if (r.kind === 'ai') f *= d.cap * (r.capScale || 1);

    /* 油門。man＝1 是鍵盤模式：不按上就不會往前，鬆手會自己滑行停下來。
     * man＝0 是觸控與電腦對手的自動前進，gas 只做加速與倒退的修正。
     * 往下一律是煞車再倒退，倒退時所有加成都不算。 */
    if (gas < 0) return C.GAS_DOWN;
    if (man) return gas > 0 ? f * C.GAS_UP : 0;
    if (gas > 0) f *= C.GAS_UP;
    return f;
  }

  /* ---------- 道具 ---------- */

  function rankOf(state, id) {
    const r = state.racers.find(x => x.id === id);
    return r ? r.rank : 1;
  }

  function useItem(state, r) {
    if (!r.item || r.finished) return;
    const id = r.item;
    const def = Items.ITEMS[id];
    r.item = null;
    r.itemReadyAt = state.t + C.ITEM_COOLDOWN;
    r.stats.itemsUsed++;
    state.events.push({ type: 'use', id: r.id, item: id });

    if (id === 'juice') {
      r.juiceUntil = state.t + def.duration;
    } else if (id === 'shield') {
      r.shieldUntil = state.t + def.duration;
    } else if (id === 'hop') {
      r.hopUntil = state.t + def.duration;
    } else if (id === 'goo') {
      const hx = Math.cos(r.angle), hy = Math.sin(r.angle);
      for (let i = 0; i < def.blobs; i++) {
        const back = (i + 1) * (C.SEG_GAP * 2.2);
        state.goo.push({
          x: r.x - hx * back, y: r.y - hy * back,
          owner: r.id, until: state.t + def.life
        });
      }
    } else if (id === 'web') {
      const target = nearestAhead(state, r, def.range);
      if (target) {
        if (!applySlow(state, target, def.duration, def.power, r)) {
          /* 被泡泡擋掉了，蜘蛛絲就當作打在泡泡上 */
        }
        /* 自己往前竄一小段（拉近距離） */
        r.vx += Math.cos(r.angle) * C.BASE_SPEED * def.pull;
        r.vy += Math.sin(r.angle) * C.BASE_SPEED * def.pull;
        state.webs.push({ from: r.id, to: target.id, until: state.t + 0.4 });
      } else {
        state.events.push({ type: 'miss', id: r.id, item: id });
      }
    } else if (id === 'tiny') {
      /* 打現在的第一名；自己就是第一名的話打第二名 */
      let target = null;
      for (const o of state.racers) {
        if (o.finished || o.ghost) continue;
        if (o.id === r.id) continue;
        if (!target || o.rank < target.rank) target = o;
      }
      if (target && rankOf(state, r.id) !== 1) {
        const leader = state.racers.filter(o => !o.finished && !o.ghost && o.id !== r.id)
          .sort((a, b) => a.rank - b.rank)[0];
        target = leader || target;
      }
      if (target) {
        if (state.t < target.shieldUntil) {
          target.shieldUntil = 0;
          state.events.push({ type: 'blocked', id: target.id, by: r.id, item: id });
        } else {
          target.tinyUntil = state.t + def.duration;
          r.stats.itemHits++;
          state.events.push({ type: 'hit', id: target.id, by: r.id, item: id });
        }
      } else {
        state.events.push({ type: 'miss', id: r.id, item: id });
      }
    }
  }

  /** 前方最近的一位（依進度，不是依直線距離，8 字型賽道才不會打到對面的人） */
  function nearestAhead(state, r, range) {
    let best = null, bestGap = Infinity;
    for (const o of state.racers) {
      if (o.id === r.id || o.finished || o.ghost) continue;
      const gap = o.progress - r.progress;
      if (gap <= 0) continue;
      const dist = gap * Tracks.NODE_STEP;
      if (dist > range) continue;
      if (dist < bestGap) { bestGap = dist; best = o; }
    }
    return best;
  }

  /**
   * 套用減速。被泡泡擋下回傳 false。
   * @returns {boolean} 有沒有真的打中
   */
  function applySlow(state, target, duration, power, from) {
    if (state.t < target.hopUntil) {
      state.events.push({ type: 'dodge', id: target.id });
      return false;
    }
    if (state.t < target.shieldUntil) {
      target.shieldUntil = 0;
      state.events.push({ type: 'blocked', id: target.id, by: from ? from.id : null });
      return false;
    }
    /* 已經在減速就取比較重的那個，不疊加 */
    if (state.t < target.slowUntil && target.slowPower >= power) {
      target.slowUntil = Math.max(target.slowUntil, state.t + duration);
    } else {
      target.slowUntil = state.t + duration;
      target.slowPower = power;
    }
    if (from) from.stats.itemHits++;
    state.events.push({ type: 'hit', id: target.id, by: from ? from.id : null });
    return true;
  }

  /* ---------- 碰撞 ---------- */

  function bounceCircle(r, cx, cy, radius) {
    const dx = r.x - cx, dy = r.y - cy;
    const dist = Math.hypot(dx, dy) || 0.0001;
    const overlap = radius + C.BODY_R - dist;
    if (overlap <= 0) return false;
    const nx = dx / dist, ny = dy / dist;
    r.x += nx * overlap;
    r.y += ny * overlap;
    const dot = r.vx * nx + r.vy * ny;
    if (dot < 0) {
      r.vx -= 2 * dot * nx;
      r.vy -= 2 * dot * ny;
    }
    r.vx *= C.WALL_KEEP;
    r.vy *= C.WALL_KEEP;
    return true;
  }

  function collide(state, r) {
    let hit = false;
    for (const rock of state.track.rocks) {
      if (bounceCircle(r, rock.x, rock.y, rock.r)) hit = true;
    }
    const b = state.track.bounds;
    if (r.x < b.minX + C.BODY_R) { r.x = b.minX + C.BODY_R; r.vx = Math.abs(r.vx) * C.WALL_KEEP; hit = true; }
    if (r.x > b.maxX - C.BODY_R) { r.x = b.maxX - C.BODY_R; r.vx = -Math.abs(r.vx) * C.WALL_KEEP; hit = true; }
    if (r.y < b.minY + C.BODY_R) { r.y = b.minY + C.BODY_R; r.vy = Math.abs(r.vy) * C.WALL_KEEP; hit = true; }
    if (r.y > b.maxY - C.BODY_R) { r.y = b.maxY - C.BODY_R; r.vy = -Math.abs(r.vy) * C.WALL_KEEP; hit = true; }
    if (hit) {
      r.stats.hits++;
      state.events.push({ type: 'wall', id: r.id });
    }
  }

  /** 毛毛蟲互相推擠：不會撞死人，只是互相擠開並各掉一點速 */
  function bumpRacers(state) {
    const list = state.racers;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (a.ghost || a.finished) continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (b.ghost || b.finished) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const dist = Math.hypot(dx, dy);
        const min = C.BODY_R * 2;
        if (dist >= min || dist < 1e-6) continue;
        const nx = dx / dist, ny = dy / dist;
        const push = (min - dist) / 2;
        a.x -= nx * push; a.y -= ny * push;
        b.x += nx * push; b.y += ny * push;
        a.vx *= C.BUMP_KEEP; a.vy *= C.BUMP_KEEP;
        b.vx *= C.BUMP_KEEP; b.vy *= C.BUMP_KEEP;
        state.events.push({ type: 'bump', id: a.id, other: b.id });
      }
    }
  }

  /* ---------- 進度與計圈 ---------- */

  function updateProgress(state, r) {
    const track = state.track;
    const N = state.trackNodes;
    const prev = r.node;
    r.node = Tracks.nodeAt(track, r.x, r.y, prev);

    /* 計圈用「累計通過幾個檢查點」而不是「越過幾次終點線」。
     *
     * 只看終點線的話，在線前後來回開就能一直加圈：
     * 往回越線只是把檢查點退回去，往前再越一次又算一圈，圈數就被刷出來了。
     * 改成累計之後，來回一次是 +1 -1，剛好抵銷，只有真的繞完一圈才會進位。 */
    const CP = track.checkpoints;
    const cp = Tracks.checkpointOf(track, r.node);
    if (cp === (r.cp + 1) % CP) { r.cp = cp; r.cpCount++; }
    else if (cp === (r.cp - 1 + CP) % CP) { r.cp = cp; r.cpCount--; }

    if (r.cpCount >= 0 && !r.started) {
      r.started = true;
      r.lapStart = state.raceT;
    }

    /* 衝刺賽道：沒有圈數，跑到最後幾個節點就算完賽。
     * 還是要檢查檢查點累計，免得有人倒著開回起點再從另一頭摸到終點。 */
    if (track.open) {
      r.progress = r.node;
      if (!r.finished && r.node >= N - 4 && r.cpCount >= CP - 2) finish(state, r);
      return;
    }
    const lap = Math.max(0, Math.floor(r.cpCount / CP));
    if (lap > r.lap) {
      r.lap = lap;
      r.lapTimes.push(state.raceT - r.lapStart);
      r.lapStart = state.raceT;
      state.events.push({ type: 'lap', id: r.id, lap: r.lap });
      if (r.lap >= state.laps && !r.finished) finish(state, r);
    } else if (lap < r.lap) {
      /* 倒退回去就把圈數收回來，記到一半的單圈時間也一起丟掉 */
      r.lap = lap;
      r.lapTimes.length = Math.min(r.lapTimes.length, lap);
    }

    r.progress = (r.started ? r.lap : -1) * N + r.node;
  }

  function finish(state, r) {
    r.finished = true;
    r.finishTime = state.raceT;
    if (!state.firstFinishAt) {
      state.firstFinishAt = state.raceT;
      /* 第一名衝線就開始倒數，時間到還沒到終點的人就算沒跑完，這一局也跟著結束 */
      state.graceEnd = state.raceT + C.FINISH_GRACE;
    }
    state.events.push({ type: 'finish', id: r.id, time: r.finishTime });
  }

  function updateRanks(state) {
    const sorted = state.racers.slice().sort((a, b) => {
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      if (a.ghost !== b.ghost) return a.ghost ? 1 : -1;
      return b.progress - a.progress;
    });
    for (let i = 0; i < sorted.length; i++) sorted[i].rank = i + 1;
  }

  /* ---------- 一個 tick ---------- */

  /**
   * @param {object} state
   * @param {object} inputs  { [racerId]: { steer: -1|0|1, use: boolean } }
   * @param {number} dt      秒；不給就用 C.TICK
   */
  function step(state, inputs, dt) {
    dt = dt || C.TICK;
    state.events.length = 0;
    state.t += dt;

    if (state.phase === 'countdown') {
      if (state.t >= C.COUNTDOWN) {
        state.phase = 'racing';
        state.events.push({ type: 'go' });
      } else {
        return state;
      }
    }
    if (state.phase === 'finished') return state;

    state.raceT = state.t - C.COUNTDOWN;

    /* 過期的黏液與蜘蛛絲 */
    for (let i = state.goo.length - 1; i >= 0; i--) if (state.goo[i].until <= state.t) state.goo.splice(i, 1);
    for (let i = state.webs.length - 1; i >= 0; i--) if (state.webs[i].until <= state.t) state.webs.splice(i, 1);

    for (const r of state.racers) {
      if (r.finished || r.ghost) continue;
      const input = (inputs && inputs[r.id]) || { steer: 0, use: false };
      const steer = clamp(Math.round(input.steer || 0), -1, 1);
      const gas = clamp(Math.round(input.gas || 0), -1, 1);
      const man = input.man ? 1 : 0;

      if (input.use && r.item && state.t >= 0) useItem(state, r);


      /* 轉向：越快越轉不動，而且角速度有慣性 */
      const ratio = clamp(r.speed / C.BASE_SPEED, 0, 1.6);
      const turn = C.TURN * (1 - C.TURN_SPEED_FALLOFF * Math.min(1, ratio));
      const wantTurn = steer * turn;
      const turnRate = (steer === 0 ? C.TURN_RELEASE : C.TURN_ACCEL) * dt;
      r.turnVel = moveToward(r.turnVel, wantTurn, turnRate);
      r.angle += r.turnVel * dt;
      if (r.angle > Math.PI) r.angle -= Math.PI * 2;
      if (r.angle < -Math.PI) r.angle += Math.PI * 2;

      /* 地形 */
      const surface = surfaceFor(state, r);
      if (surface === S.BOOST) {
        if (state.t >= r.padUntil - C.PAD_TIME + 0.4) r.stats.pads++;
        r.padUntil = state.t + C.PAD_TIME;
        state.events.push({ type: 'pad', id: r.id });
      }
      if (surface === S.GRASS) r.stats.offTrack++;
      /* 水坑：只在「剛踏進去」的那一刻發事件，不然每 tick 都在濺水 */
      if (surface === S.WATER) {
        if (r.surface !== S.WATER) state.events.push({ type: 'splash', id: r.id });
        r.stats.splash++;
      }
      if (surface === S.DOWN) r.stats.downhill++;
      r.surface = surface;

      /* 把速度拆成「朝向前方」與「橫向滑移」兩份 */
      const hx = Math.cos(r.angle), hy = Math.sin(r.angle);
      let vLong = r.vx * hx + r.vy * hy;
      let vLat = r.vx * (-hy) + r.vy * hx;

      const target = C.BASE_SPEED * speedFactor(state, r, surface, steer, gas, man);
      const rate = (vLong < target ? C.ACCEL : C.BRAKE) * dt;
      vLong = moveToward(vLong, target, rate);

      /* 抓地力吃掉橫向速度；草地上吃得慢，所以會滑出去 */
      const grip = C.GRIP[state.t < r.hopUntil ? S.TRACK : surface];
      vLat *= Math.pow(grip, dt);

      r.vx = hx * vLong - hy * vLat;
      r.vy = hy * vLong + hx * vLat;
      r.speed = Math.hypot(r.vx, r.vy);

      r.x += r.vx * dt;
      r.y += r.vy * dt;

      /* 飄在空中就不撞石頭 */
      if (state.t >= r.hopUntil) collide(state, r);

      /* 黏液 */
      if (state.t >= r.hopUntil) {
        for (const g of state.goo) {
          if (g.owner === r.id && state.t - (g.until - Items.ITEMS.goo.life) < 1.2) continue;
          if (Math.hypot(r.x - g.x, r.y - g.y) < C.GOO_R + C.BODY_R) {
            if (applySlow(state, r, Items.ITEMS.goo.duration, Items.ITEMS.goo.power, null)) {
              state.events.push({ type: 'goo', id: r.id });
            }
            break;
          }
        }
      }

      /* 道具葉。
       * 撞到就一定吃掉（葉子消失、過幾秒再長回來），手上已經有道具的話
       * 只是拿不到新的而已 —— 本來是「有道具就整個跳過」，結果撞上去葉子
       * 還好端端地留在原地，看起來就像撞不到。 */
      for (const leaf of state.leaves) {
        if (state.t < leaf.readyAt) continue;
        if (Math.hypot(r.x - leaf.x, r.y - leaf.y) >= C.LEAF_R + C.BODY_R) continue;
        leaf.readyAt = state.t + C.LEAF_RESPAWN;
        if (!r.item && state.t >= r.itemReadyAt) {
          r.item = Items.draw(state.rng, r.rank, state.racers.length, state.allowBad && allowBadFor(r));
          state.events.push({ type: 'pick', id: r.id, item: r.item });
        } else {
          state.events.push({ type: 'full', id: r.id });
        }
        break;
      }

      updateProgress(state, r);
    }

    bumpRacers(state);
    updateRanks(state);

    /* 全員完賽，或第一名完賽超過寬限時間，就收局 */
    const alive = state.racers.filter(r => !r.finished && !r.ghost);
    if (!alive.length || (state.graceEnd && state.raceT > state.graceEnd)) {
      state.phase = 'finished';
      for (const r of state.racers) if (!r.finished) { r.finishTime = state.raceT; }
      updateRanks(state);
      state.events.push({ type: 'over' });
    }
    return state;
  }

  /** 幼幼班的電腦不丟負面道具（規劃書 §4.2／§5） */
  function allowBadFor(r) {
    if (r.kind !== 'ai') return true;
    const d = DIFFICULTY[r.difficulty] || DIFFICULTY.normal;
    return d.useBad;
  }

  /* ---------- 線上用的輔助 ---------- */

  /** 掉線：幽靈化，停在原地且不參與碰撞，位置保留 */
  function markGhost(state, id, on) {
    const r = state.racers.find(x => x.id === id);
    if (!r) return;
    r.ghost = !!on;
    r.connected = !on;
    if (on) { r.vx = 0; r.vy = 0; r.speed = 0; r.turnVel = 0; }
  }

  /** 給前端畫面與 Summary 用的精簡快照 */
  function snapshot(state) {
    return {
      t: +state.t.toFixed(3),
      raceT: +state.raceT.toFixed(3),
      phase: state.phase,
      laps: state.laps,
      /* 收局倒數也要同步，不然連線時客戶端根本不知道在倒數（頭上的秒數就不會出現） */
      ge: +state.graceEnd.toFixed(2),
      racers: state.racers.map(r => ({
        id: r.id, x: +r.x.toFixed(2), y: +r.y.toFixed(2), a: +r.angle.toFixed(3),
        sp: +r.speed.toFixed(1), tv: +r.turnVel.toFixed(3), lap: r.lap, cp: r.cp, rank: r.rank,
        item: r.item,
        boost: (r.juiceUntil > state.t || r.padUntil > state.t) ? 1 : 0,
        slow: r.slowUntil > state.t ? 1 : 0,
        shield: r.shieldUntil > state.t ? 1 : 0,
        hop: r.hopUntil > state.t ? 1 : 0,
        tiny: r.tinyUntil > state.t ? 1 : 0,
        fin: r.finished ? 1 : 0, ft: +r.finishTime.toFixed(2),
        ghost: r.ghost ? 1 : 0
      })),
      goo: state.goo.map(g => ({ x: Math.round(g.x), y: Math.round(g.y) })),
      leaves: state.leaves.map(l => (state.t >= l.readyAt ? 1 : 0)),
      webs: state.webs.map(w => ({ from: w.from, to: w.to }))
    };
  }

  /** 結算：名次、完成時間、最佳單圈、統計 */
  function results(state) {
    return state.racers.slice().sort((a, b) => a.rank - b.rank).map(r => ({
      id: r.id, name: r.name, char: r.char, kind: r.kind, difficulty: r.difficulty,
      rank: r.rank,
      finished: r.finished,
      time: +r.finishTime.toFixed(2),
      laps: r.lap,
      bestLap: r.lapTimes.length ? +Math.min.apply(null, r.lapTimes).toFixed(2) : 0,
      lapTimes: r.lapTimes.map(v => +v.toFixed(2)),
      stats: r.stats
    }));
  }

  return {
    C, DIFFICULTY, DIFFICULTY_LIST,
    createRace, step, snapshot, results,
    useItem, applySlow, updateRanks, updateProgress, markGhost,
    nearestAhead, speedFactor, surfaceFor, moveToward, clamp
  };
});
