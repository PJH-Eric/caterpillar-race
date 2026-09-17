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

    function applySnapshot(msg) {
      if (!state) return;
      const s = msg.s;
      lastSnapAt = performance.now();

      /* 時間與階段一律以伺服器為準，效果的倒數才不會跟別人對不起來 */
      state.t = s.t;
      state.raceT = s.raceT;
      state.phase = s.phase;
      state.laps = s.laps;

      for (const sr of s.racers) {
        const r = state.racers.find(x => x.id === sr.id);
        if (!r) continue;

        const soft = (r.id === meId) ? 0.18 : SNAP_SOFT;
        const dx = sr.x - r.x, dy = sr.y - r.y;
        const err = Math.hypot(dx, dy);
        if (err > SNAP_HARD || sr.ghost || sr.fin) {
          r.x = sr.x; r.y = sr.y; r.angle = sr.a;
        } else {
          r.x += dx * soft;
          r.y += dy * soft;
          let da = sr.a - r.angle;
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
        r.wiggle.beats = sr.beats;
        r.wiggle.until = sr.wig ? state.t + 0.2 : 0;
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
