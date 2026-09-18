/* ===== net.js — WebSocket 連線、預測與校正 =====
 *
 * 伺服器是唯一的真相（30Hz 權威迴圈），但快照只有 15Hz，
 * 直接照快照畫會一頓一頓的。所以前端自己也跑一份 rules.js：
 *   自己    ：吃本地輸入往前跑，收到快照再把誤差慢慢拉回來（誤差太大就直接對齊）
 *   其他人  ：以最後已知的速度往前推（航位推算），收到快照再拉回來
 *   權威欄位：圈數、名次、道具、狀態效果、黏液、道具葉一律以快照為準，不猜
 *
 * 本地模擬產生的事件一律丟掉，只播伺服器送來的事件，免得音效放兩次。
 */
(function (root) {
  'use strict';

  const Rules = root.Rules;

  function create(opt) {
    opt = opt || {};
    let sock = null;
    let open = false;
    let closedByUs = false;
    let retry = 0;
    let retryTimer = 0;
    const listeners = {};

    let state = null;          /* 本地預測用的 race state */
    let meId = null;
    let acc = 0;
    let lastSent = 0;
    let lastSnapAt = 0;
    let ping = 0;
    let readInput = () => ({ steer: 0, gas: 0, man: 0, use: false });

    function on(type, fn) {
      (listeners[type] || (listeners[type] = [])).push(fn);
    }
    function emit(type, data) {
      for (const fn of listeners[type] || []) {
        try { fn(data); } catch (e) { console.error('[net] ' + type, e); }
      }
    }

    function connect(url) {
      if (!url) { emit('status', { state: 'noserver' }); return; }
      closedByUs = false;
      emit('status', { state: retry ? 'retry' : 'connecting', retry: retry });
      try { sock = new WebSocket(url); } catch (e) { scheduleRetry(url); return; }

      sock.onopen = () => {
        open = true; retry = 0;
        emit('status', { state: 'online' });
      };
      sock.onmessage = ev => {
        let msg = null;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (msg.type === 'snap') applySnapshot(msg);
        emit(msg.type, msg);
        emit('*', msg);
      };
      sock.onclose = () => {
        open = false;
        if (closedByUs) { emit('status', { state: 'closed' }); return; }
        emit('status', { state: 'lost' });
        scheduleRetry(url);
      };
      sock.onerror = () => { /* onclose 會接著來，這裡不用做事 */ };
    }

    function scheduleRetry(url) {
      if (closedByUs) return;
      retry++;
      /* 指數退避，但最多等 8 秒；Render 免費方案冷啟動要 30～60 秒，要一直試 */
      const wait = Math.min(8000, 500 * Math.pow(1.7, Math.min(retry, 6)));
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => connect(url), wait);
    }

    function send(obj) {
      if (!open || !sock) return false;
      try { sock.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
    }

    function close() {
      closedByUs = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (sock) { try { sock.close(); } catch (e) { /* 忽略 */ } }
      sock = null; open = false;
      detach();
    }

    /* ---------- 對局 ---------- */

    function attach(raceState, myId, inputReader) {
      state = raceState;
      /* 本地這一份只是預測用的：圈數與完賽不自己算，一律等快照 */
      state.predicted = true;
      meId = myId;
      acc = 0; lastSent = 0; lastSnapAt = performance.now();
      if (inputReader) readInput = inputReader;
    }
    function detach() { state = null; meId = null; }

    /** 每一幀呼叫：推進本地預測，並以 30Hz 把自己的輸入送出去 */
    function tick(dt) {
      if (!state) return;
      acc += Math.min(dt, 0.25);
      let guard = 0;
      while (acc >= Rules.C.TICK && guard++ < 6) {
        const inputs = {};
        const me = state.racers.find(r => r.id === meId);
        if (me && !me.finished && !me.ghost) {
          const raw = readInput();
          inputs[meId] = raw;
          /* 輸入送給伺服器；use 是邊緣觸發，有按到就一定要送出去 */
          const now = performance.now();
          if (raw.use || now - lastSent > 33) {
            send({ type: 'input', steer: raw.steer, gas: raw.gas || 0, man: raw.man || 0, use: raw.use });
            lastSent = now;
          }
        }
        Rules.step(state, inputs);
        /* 本地事件不播，一律等伺服器的，不然音效會放兩次 */
        state.events.length = 0;
        acc -= Rules.C.TICK;
      }
    }

    /* 誤差多大就不再慢慢拉、直接對齊 */
    const SNAP_HARD = 70;
    const SNAP_SOFT = 0.30;
    /* 快照往前推算的上限（秒）。延遲再大也不要推超過這麼多，
     * 不然對手剛撞牆或剛轉彎時會推到牆裡去。 */
    const LEAD_MAX = 0.35;

    function applySnapshot(msg) {
      if (!state) return;
      const s = msg.s;
      lastSnapAt = performance.now();

      /* 階段與圈數一律以伺服器為準 */
      state.phase = s.phase;
      state.laps = s.laps;

      /* 時間只往前走，不倒退。
       *
       * 快照是延遲抵達的，所以 s.t 一定比本地預測的 state.t 小一截。
       * 原本直接照抄，state.t 就每 67ms 往回跳一次，變成一條鋸齒 ——
       * HUD 的計時、收局倒數、身體動畫的相位都跟著抖。
       * 本地與伺服器都用同一個固定步長推進，所以兩邊的差距就是延遲，
       * 不會愈差愈多；真的差超過半秒（分頁被切走、補跑一大段）才硬對齊。 */
      const TIME_RESYNC = 0.5;
      if (s.t > state.t || state.t - s.t > TIME_RESYNC) state.t = s.t;
      state.raceT = state.t - Rules.C.COUNTDOWN;

      /* 這份快照有多舊：本地預測的時鐘減掉快照的時鐘。
       *
       * 兩邊都用同一個固定步長推進，所以這個差就是「封包在路上花的時間」，
       * 不用另外量 ping。時間那一段已經保證 state.t 只往前走，所以這個值穩定。
       *
       * 為什麼要用它：快照描述的是 lag 秒前的世界，而本地預測已經跑到現在。
       * 直接拿快照的座標來比，本地「本來就該領先的那一段」會被當成誤差 ——
       * 以基礎速度 150 跑、延遲 264ms 來算就是 40 單位。實測本地與伺服器的
       * 平均差距 33 單位、尖峰 83～95，而硬對齊的門檻是 70：
       * 也就是說每隔一陣子就會被硬拉一次，那就是玩家感覺到的「延遲抖動」。
       *
       * 所以比之前先把快照按它自己的速度往前推 lag 秒，兩邊才是同一個時刻。 */
      const lag = Math.max(0, Math.min(LEAD_MAX, state.t - s.t));

      for (const sr of s.racers) {
        const r = state.racers.find(x => x.id === sr.id);
        if (!r) continue;

        /* 推算：沿著快照當下的朝向前進。完賽或幽靈的不推（他們不動了）。 */
        let sx = sr.x, sy = sr.y;
        if (lag > 0 && !sr.fin && !sr.ghost) {
          sx += Math.cos(sr.a) * sr.sp * lag;
          sy += Math.sin(sr.a) * sr.sp * lag;
        }

        const soft = (r.id === meId) ? 0.18 : SNAP_SOFT;
        const dx = sx - r.x, dy = sy - r.y;
        const err = Math.hypot(dx, dy);
        /* 硬對齊只留給「真的差太多」與幽靈（掉線的人停在原地）。
         *
         * 完賽的人本來也在這裡硬對齊，但那會在衝線的瞬間把本地預測領先的
         * 那一段（約 40 單位）一次拉回來，看起來就是終點線上往後跳一下。
         * 完賽的人不會再動，所以用一般的漸進校正就會很快收斂，而且是平滑的。 */
        if (err > SNAP_HARD || sr.ghost) {
          r.x = sx; r.y = sy; r.angle = sr.a;
        } else {
          r.x += dx * soft;
          r.y += dy * soft;
          /* 角度同理，用快照的角速度往前推 */
          let da = (sr.a + (sr.tv || 0) * lag) - r.angle;
          while (da > Math.PI) da -= Math.PI * 2;
          while (da < -Math.PI) da += Math.PI * 2;
          r.angle += da * soft;
        }
        /* 速度用來做航位推算：把伺服器的速度換算回速度向量 */
        r.speed = sr.sp;
        r.vx = Math.cos(r.angle) * sr.sp;
        r.vy = Math.sin(r.angle) * sr.sp;
        if (sr.tv !== undefined) r.turnVel = sr.tv;

        /* 權威欄位：不猜，直接照抄 */
        r.lap = sr.lap; r.cp = sr.cp; r.rank = sr.rank;
        r.item = sr.item;
        r.started = sr.lap > 0 || sr.cp > 0 || sr.fin === 1 ? true : r.started;
        r.juiceUntil = sr.boost ? state.t + 0.2 : 0;
        r.padUntil = 0;
        r.slowUntil = sr.slow ? state.t + 0.2 : 0;
        r.shieldUntil = sr.shield ? state.t + 0.2 : 0;
        r.hopUntil = sr.hop ? state.t + 0.2 : 0;
        r.tinyUntil = sr.tiny ? state.t + 0.2 : 0;
        r.finished = !!sr.fin;
        r.finishTime = sr.ft;
        r.ghost = !!sr.ghost;
      }

      /* 收局倒數：伺服器說了算 */
      if (typeof s.ge === 'number') {
        state.graceEnd = s.ge;
        if (s.ge > 0 && !state.firstFinishAt) state.firstFinishAt = s.ge - Rules.C.FINISH_GRACE;
      }

      /* 黏液與道具葉也照抄，免得本地預測自己長出不存在的東西 */
      state.goo = (s.goo || []).map(g => ({ x: g.x, y: g.y, owner: null, until: state.t + 99 }));
      if (s.leaves) {
        for (let i = 0; i < state.leaves.length && i < s.leaves.length; i++) {
          state.leaves[i].readyAt = s.leaves[i] ? 0 : state.t + 99;
        }
      }
      state.webs = (s.webs || []).map(w => ({ from: w.from, to: w.to, until: state.t + 0.3 }));
    }

    return {
      connect, send, close, on, emit, attach, detach, tick, applySnapshot,
      get open() { return open; },
      get retry() { return retry; },
      get sinceSnap() { return performance.now() - lastSnapAt; },
      get ping() { return ping; }
    };
  }

  root.Net = { create };
})(typeof self !== 'undefined' ? self : this);
