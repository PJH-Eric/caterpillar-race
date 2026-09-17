/* ===== online.js — 大廳、房間、觀戰、邀請連結、聊天 =====
 *
 * 畫面流程與遊戲迴圈在 app.js，連線與預測在 net.js，這一支負責線上的 UI 與規則對接。
 * 權限（誰能改設定、誰能踢人、觀戰者不能操作）伺服器一定會再檢查一次，
 * 這裡只是讓按鈕不要出現在不該出現的地方。
 */
(function (root) {
  'use strict';

  const D = document;
  const $ = id => D.getElementById(id);
  const App = root.App;
  const Tracks = root.Tracks, Chars = root.Characters, Rules = root.Rules;

  const O = {
    net: null,
    room: null,          /* 伺服器送來的房間樣貌 */
    meId: null,
    quick: [],
    status: 'idle',
    pendingInvite: null, /* 帶著邀請連結進來時先存著，連上再送 join */
    unread: 0,
    chatOpen: false,
    inRace: false
  };

  /* ================================================================
   *  一、連線
   * ================================================================ */

  function ensureNet() {
    if (O.net) return O.net;
    const net = root.Net.create();
    O.net = net;

    net.on('status', s => {
      O.status = s.state;
      paintConn();
      if (s.state === 'online') {
        const set = App.settings;
        net.send({ type: 'hi', name: (set.nickname || '').trim() || root.Nicknames.random(), char: set.char });
        if (O.pendingInvite) {
          net.send({ type: 'join', roomId: O.pendingInvite.roomId, token: O.pendingInvite.token });
          O.pendingInvite = null;
        } else if (!O.room) {
          net.send({ type: 'rooms' });
        }
      }
    });

    net.on('hello', m => { O.meId = m.personId; O.quick = m.quick || []; });
    net.on('me', m => { O.meId = m.id; });
    net.on('rooms', m => paintRooms(m.rooms || []));
    net.on('room', m => { O.room = m.room; O.quick = m.quick || O.quick; paintRoom(); });
    net.on('left', () => { O.room = null; App.show('lobby'); net.send({ type: 'rooms' }); });
    net.on('kicked', () => { O.room = null; App.show('lobby'); notice('房主把你請出房間了'); });
    net.on('error', m => notice(m.text));
    net.on('notice', m => notice(m.text));
    net.on('invite-bad', m => { O.room = null; App.show('lobby'); notice(m.text); });
    net.on('chat', m => pushChat(m.msg));
    net.on('start', onStart);
    net.on('snap', m => { if (m.e && m.e.length) App.handleEvents(m.e); });
    net.on('over', onOver);

    net.connect(root.Config.wsUrl);
    return net;
  }

  function paintConn() {
    const text = {
      connecting: '連線中…',
      retry: '伺服器可能在睡覺，正在叫醒它…',
      online: '已連線',
      lost: '連線中斷，正在重連…',
      closed: '已離線',
      noserver: '這個版本沒有設定遊戲伺服器'
    }[O.status] || '';
    $('lobby-conn').textContent = text;
    $('room-conn').textContent = text;
  }

  function notice(text) {
    if (D.body.dataset.screen === 'race') App.toast(text);
    else {
      const el = $('room-hint');
      if (el && !$('screen-room').hidden) {
        el.textContent = text;
        setTimeout(() => { if (el.textContent === text) paintRoom(); }, 3200);
      } else App.noteFlash(text);
    }
  }

  /* ================================================================
   *  二、大廳
   * ================================================================ */

  function open(roomId, token) {
    App.show('lobby');
    if (!root.Config.wsUrl) {
      O.status = 'noserver';
      paintConn();
      paintRooms([]);
      return;
    }
    if (roomId) O.pendingInvite = { roomId: roomId, token: token };
    ensureNet();
    if (O.net.open) {
      if (O.pendingInvite) {
        O.net.send({ type: 'join', roomId: O.pendingInvite.roomId, token: O.pendingInvite.token });
        O.pendingInvite = null;
      } else O.net.send({ type: 'rooms' });
    }
    paintConn();
  }

  function paintRooms(rooms) {
    const list = $('room-list');
    if (!rooms.length) {
      list.innerHTML = '<p class="empty">' +
        (O.status === 'online' ? '現在沒有人開房間。按「快速加入」就會幫你開一間。'
          : (O.status === 'noserver' ? '這個版本沒有設定遊戲伺服器，只能玩單機。' : '正在跟伺服器連線…')) +
        '</p>';
      return;
    }
    let html = '';
    for (const r of rooms) {
      const track = Tracks.BY_ID[r.trackId];
      const full = r.players >= r.seats;
      html += '<div class="room-row">' +
        '<span><b class="r-name">' + App.escapeHtml(r.name) + '</b>' +
        '<br><span class="r-meta">' + (track ? track.name : '隨機賽道') + ' ・ ' + r.laps + ' 圈 ・ ' +
        r.players + '/' + r.seats + ' 人' + (r.spectators ? ' ・ 觀戰 ' + r.spectators : '') +
        (r.phase === 'racing' ? ' ・ 比賽中' : '') + '</span></span>' +
        '<span class="spacer"></span>' +
        '<button class="mini-btn" data-join="' + r.id + '" data-role="' +
        (r.phase === 'racing' || full ? 'spectator' : 'player') + '">' +
        (r.phase === 'racing' ? '觀戰' : (full ? '觀戰（滿）' : '加入')) + '</button>' +
        '</div>';
    }
    list.innerHTML = html;
    for (const b of list.querySelectorAll('[data-join]')) {
      b.addEventListener('click', () => {
        O.net.send({ type: 'join', roomId: b.dataset.join, role: b.dataset.role });
      });
    }
  }

  /* ================================================================
   *  三、房間
   * ================================================================ */

  function paintRoom() {
    const room = O.room;
    if (!room) return;
    if (D.body.dataset.screen !== 'race' && D.body.dataset.screen !== 'result') App.show('room');

    $('room-title').textContent = room.name;
    const seats = room.members.filter(m => m.role === 'player').sort((a, b) => a.seat - b.seat);
    $('seat-count').textContent = seats.length + '/' + room.seats;

    /* 席位 */
    let html = '';
    for (let i = 0; i < room.seats; i++) {
      const m = seats.find(x => x.seat === i);
      if (!m) {
        html += '<div class="seat empty-seat"><span class="s-name">空位</span></div>';
        continue;
      }
      const ch = Chars.get(m.char);
      const stateText = !m.connected ? '掉線了'
        : (m.owner ? '房主 ・ 等待其他玩家' : (m.ready ? '準備好了' : '還沒準備'));
      html += '<div class="seat' + (m.ready ? ' ready' : '') + '">' +
        root.Render.wormSvg(ch, 40) +
        '<span><span class="s-name">' + App.escapeHtml(m.name) + '</span>' +
        '<br><span class="s-tag">' + stateText + '</span></span>' +
        '<span class="spacer"></span>' +
        (room.isOwner && m.id !== O.meId
          ? '<button class="mini-btn" data-kick="' + m.id + '">請他離開</button>' : '') +
        '</div>';
    }
    $('seat-list').innerHTML = html;

    /* 與單機共用圖片賽道卡片（含分頁），選擇狀態以伺服器回覆為準。 */
    const grid = $('room-track-grid');
    const onGrid = [].filter.call(grid.children, c => c.dataset.trackId === room.trackId).length > 0;
    /* 只有「房主換了賽道、而且換到別的分頁」才自動跳過去。
     * 不比對有沒有換的話，自己切分頁看別類賽道時會被一直拉回去。 */
    const moved = O.shownTrack !== room.trackId;
    O.shownTrack = room.trackId;
    if (!grid.children.length || (moved && !onGrid)) {
      if (moved && !onGrid) grid.dataset.tab = '';
      App.buildTrackGrid(grid, room.trackId, def => {
        if (!O.room || !O.room.isOwner || O.room.phase === 'racing') return;
        O.net.send({ type: 'setup', trackId: def.id });
      });
    }
    for (const card of grid.children) {
      card.setAttribute('aria-checked', String(card.dataset.trackId === room.trackId));
      card.disabled = !room.isOwner || room.phase === 'racing';
    }
    $('room-track-hint').textContent = room.isOwner
      ? '點選圖片選擇賽道，圈數依賽道設定。'
      : '由房主選擇賽道，圈數依賽道設定。';

    /* 房主設定 */
    const ownerBox = $('room-owner-only');
    ownerBox.hidden = !room.isOwner;
    if (room.isOwner) fillOwnerControls(room);

    const me = room.members.find(m => m.id === O.meId);
    const isPlayer = me && me.role === 'player';
    const isOwner = !!room.isOwner;
    $('room-ready').hidden = !isPlayer || isOwner;
    $('room-ready').textContent = (me && me.ready) ? '取消準備' : '我準備好了';
    const startBtn = $('room-start');
    startBtn.hidden = !isOwner;
    $('room-switch').hidden = !!isPlayer;
    $('room-switch').disabled = room.phase === 'racing';

    const connectedSeats = seats.filter(m => m.connected);
    const others = connectedSeats.filter(m => m.id !== room.ownerId);
    const ready = others.filter(m => m.ready).length;
    const allOthersReady = connectedSeats.length >= 2 && others.every(m => m.ready);
    startBtn.disabled = room.phase !== 'lobby' || !allOthersReady;
    $('room-hint').textContent = room.phase === 'racing'
      ? '比賽進行中，這一局結束後可以上場。'
      : (connectedSeats.length < 2
        ? '至少要兩隻毛毛蟲才能開跑。把邀請連結傳給朋友吧。'
        : (isOwner
          ? (allOthersReady ? '其他玩家都準備好了，按「開始遊戲」吧。' : '等其他玩家準備好，再按「開始遊戲」。')
          : '按下準備，等房主開始遊戲（' + ready + '/' + connectedSeats.length + '）。'));

    $('room-invite').textContent = room.inviteRevoked ? '重新產生邀請連結' : '複製邀請連結';

    for (const b of $('seat-list').querySelectorAll('[data-kick]')) {
      b.addEventListener('click', () => O.net.send({ type: 'kick', id: b.dataset.kick }));
    }
    paintChat();
  }

  function buildSeatPicker() {
    const select = $('room-seats');
    const picker = $('room-seats-picker');
    const trigger = $('room-seats-trigger');
    const valueEl = $('room-seats-value');
    const menu = $('room-seats-menu');
    if (!select || !picker || !trigger || !valueEl || !menu || picker.dataset.ready) return;

    const options = [2, 3, 4, 5, 6];
    menu.innerHTML = options.map(n =>
      '<button class="select-option" type="button" role="option" data-value="' + n + '">' + n + ' 人</button>'
    ).join('');

    const setValue = (value, notify) => {
      const next = options.includes(Number(value)) ? String(value) : String(options[0]);
      select.value = next;
      valueEl.textContent = next + ' 人';
      for (const option of menu.querySelectorAll('[role="option"]')) {
        option.setAttribute('aria-selected', String(option.dataset.value === next));
      }
      if (notify) pushSetup();
    };
    const close = () => {
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
    };
    const open = () => {
      menu.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
    };
    const toggle = () => (menu.hidden ? open() : close());
    const move = step => {
      const index = options.indexOf(Number(select.value));
      const nextIndex = (Math.max(0, index) + step + options.length) % options.length;
      setValue(options[nextIndex], true);
    };

    for (const option of menu.querySelectorAll('[role="option"]')) {
      option.addEventListener('click', () => {
        setValue(option.dataset.value, true);
        close();
        trigger.focus();
      });
    }
    trigger.addEventListener('click', toggle);
    trigger.addEventListener('keydown', e => {
      if (e.key === 'Escape') { if (!menu.hidden) { e.preventDefault(); close(); } return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (menu.hidden) open();
        move(e.key === 'ArrowDown' ? 1 : -1);
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault(); toggle();
      }
    });
    D.addEventListener('click', e => { if (!picker.contains(e.target)) close(); });
    picker.dataset.ready = '1';
    setValue(select.value || options[0], false);
  }

  function fillOwnerControls(room) {
    if ($('room-seats').options.length === 0) {
      $('room-seats').innerHTML = [2, 3, 4, 5, 6].map(n => '<option value="' + n + '">' + n + ' 人</option>').join('');
      buildSeatPicker();
      $('room-bad').addEventListener('change', pushSetup);
    } else buildSeatPicker();
    $('room-seats').value = String(room.seats);
    const valueEl = $('room-seats-value');
    if (valueEl) valueEl.textContent = String(room.seats) + ' 人';
    for (const option of $('room-seats-menu').querySelectorAll('[role="option"]')) {
      option.setAttribute('aria-selected', String(option.dataset.value === String(room.seats)));
    }
    $('room-bad').checked = !!room.allowBad;
  }

  function pushSetup() {
    O.net.send({
      type: 'setup',
      seats: Number($('room-seats').value),
      allowBad: $('room-bad').checked
    });
  }

  function inviteUrl() {
    if (!O.room || !O.room.invite) return null;
    const base = root.location.origin + root.location.pathname;
    return base + '?room=' + encodeURIComponent(O.room.id) + '&t=' + encodeURIComponent(O.room.invite);
  }

  async function copyInvite() {
    if (!O.room) return;
    if (O.room.inviteRevoked || !O.room.invite) {
      O.net.send({ type: 'invite', action: 'new' });
      notice('已經產生新的邀請連結，再按一次就會複製。');
      return;
    }
    const url = inviteUrl();
    try {
      await navigator.clipboard.writeText(url);
      notice('邀請連結複製好了，傳給朋友吧。');
    } catch (e) {
      /* 沒有剪貼簿權限（http 或舊瀏覽器）就把網址直接秀出來讓人手動複製 */
      notice('複製不了，網址是：' + url);
    }
  }

  /* ================================================================
   *  四、聊天（房間畫面用面板，比賽中用左下角浮動面板）
   * ================================================================ */

  function pushChat(msg) {
    if (!O.room) return;
    O.room.chat.push(msg);
    if (O.room.chat.length > 40) O.room.chat.shift();
    if (D.body.dataset.screen === 'race' && !O.chatOpen) {
      O.unread++;
      const el = $('chat-unread');
      el.hidden = false;
      el.textContent = String(O.unread);
    }
    paintChat();
  }

  /* 房間畫面與比賽畫面各有一個聊天面板，內容一樣，兩邊一起更新 */
  function paintChat() {
    if (!O.room) return;
    const html = O.room.chat.map(m => m.sys
      ? '<li class="sys">' + App.escapeHtml(m.text) + '</li>'
      : '<li><b>' + App.escapeHtml(m.name) + '</b>：' + App.escapeHtml(m.text) + '</li>').join('');
    for (const id of ['chat-log', 'room-chat-log']) {
      const log = $(id);
      if (!log) continue;
      log.innerHTML = html;
      log.scrollTop = log.scrollHeight;
    }
    for (const id of ['chat-quick', 'room-chat-quick']) {
      const quick = $(id);
      if (!quick || quick.children.length || !O.quick.length) continue;
      quick.innerHTML = O.quick.map(t => '<button type="button">' + App.escapeHtml(t) + '</button>').join('');
      for (const b of quick.children) {
        b.addEventListener('click', () => O.net.send({ type: 'chat', text: b.textContent }));
      }
    }
  }

  function toggleChat() {
    O.chatOpen = !O.chatOpen;
    $('chat-panel').hidden = !O.chatOpen;
    $('chat-toggle').setAttribute('aria-expanded', String(O.chatOpen));
    if (O.chatOpen) {
      O.unread = 0;
      $('chat-unread').hidden = true;
      paintChat();
    }
  }

  /* ================================================================
   *  五、對局
   * ================================================================ */

  function onStart(m) {
    const me = O.room ? O.room.members.find(x => x.id === O.meId) : null;
    const spectating = !m.racers.some(r => r.id === O.meId);

    const state = App.startRace({
      mode: 'online',
      trackId: m.trackId,
      seed: m.seed,
      laps: m.laps,
      allowBad: m.allowBad,
      /* 觀戰者沒有自己的毛毛蟲，鏡頭就跟著第一名跑 */
      meId: spectating ? m.racers[0].id : O.meId,
      racers: m.racers.map(r => ({ id: r.id, name: r.name, char: r.char, kind: 'human', difficulty: 'normal' }))
    });

    O.inRace = true;
    O.unread = 0;
    $('chat-unread').hidden = true;
    $('chat-panel').hidden = true;
    O.chatOpen = false;
    O.spectating = spectating;

    O.net.attach(state, spectating ? null : O.meId, () => App.G.input.read());
    if (spectating) App.toast('你是觀戰者，下一局可以上場');
    paintChat();
  }

  function onOver(m) {
    O.inRace = false;
    O.net.detach();
    if (App.G.state && App.G.mode === 'online') {
      /* 名次與時間以伺服器為準，不要用本地預測的結果 */
      for (const r of m.results) {
        const local = App.G.state.racers.find(x => x.id === r.id);
        if (!local) continue;
        local.rank = r.rank;
        local.finished = r.finished;
        local.finishTime = r.time;
        local.lap = r.laps;
        local.lapTimes = r.lapTimes || [];
        local.stats = r.stats || local.stats;
      }
      App.endRace();
    }
  }

  function tick(dt) {
    if (O.net) O.net.tick(dt);
  }

  function statusText() {
    if (!O.net) return '';
    if (O.status === 'lost' || O.status === 'retry') return '連線中斷，正在重連…';
    if (O.net.sinceSnap > 1500) return '等伺服器回應中…';
    if (O.spectating) return '你是觀戰者';
    return '';
  }

  /* ================================================================
   *  六、離開
   * ================================================================ */

  function leaveRoom() {
    if (O.net && O.room) O.net.send({ type: 'leaveRoom' });
    O.room = null;
    App.show('lobby');
    if (O.net) O.net.send({ type: 'rooms' });
  }

  function leave() {
    if (O.net) {
      if (O.room) O.net.send({ type: 'leaveRoom' });
      O.net.close();
      O.net = null;
    }
    O.room = null;
    O.inRace = false;
    O.status = 'idle';
  }

  function backToRoom() {
    if (O.net) O.net.send({ type: 'again' });
    App.show('room');
    paintRoom();
  }

  /** 結算浮層上的「再玩一場」：把房間收回大廳狀態，順手把自己標成準備好 */
  function readyAgain() {
    if (!O.net) return false;
    O.net.send({ type: 'again' });
    if (!(O.room && O.room.isOwner)) O.net.send({ type: 'ready', ready: true });
    return true;
  }

  /* ================================================================
   *  七、接線
   * ================================================================ */

  function wire() {
    $('quick-join').addEventListener('click', () => {
      ensureNet();
      if (O.net.open) O.net.send({ type: 'quick' });
      else notice('還在連線，請稍等一下');
    });
    $('create-room').addEventListener('click', () => {
      ensureNet();
      if (!O.net.open) { notice('還在連線，請稍等一下'); return; }
      O.net.send({
        type: 'create',
        trackId: App.settings.lastTrack === 'random' ? 'random' : App.settings.lastTrack,
        seats: 4, allowBad: App.settings.allowBad
      });
    });
    $('room-ready').addEventListener('click', () => {
      const me = O.room && O.room.members.find(m => m.id === O.meId);
      O.net.send({ type: 'ready', ready: !(me && me.ready) });
    });
    $('room-start').addEventListener('click', () => {
      if (O.room && O.room.isOwner) O.net.send({ type: 'start' });
    });
    $('room-switch').addEventListener('click', () => {
      const me = O.room && O.room.members.find(m => m.id === O.meId);
      O.net.send({ type: 'switch', role: (me && me.role === 'player') ? 'spectator' : 'player' });
    });
    $('room-invite').addEventListener('click', copyInvite);
    $('chat-toggle').addEventListener('click', toggleChat);
    for (const pair of [['chat-form', 'chat-input'], ['room-chat-form', 'room-chat-input']]) {
      const form = $(pair[0]);
      if (!form) continue;
      form.addEventListener('submit', e => {
        e.preventDefault();
        const input = $(pair[1]);
        const text = input.value.trim();
        if (!text || !O.net) return;
        O.net.send({ type: 'chat', text: text });
        input.value = '';
      });
    }
  }

  root.Online = {
    open, leave, leaveRoom, backToRoom, readyAgain, tick, statusText,
    get room() { return O.room; },
    get meId() { return O.meId; },
    inviteUrl, O
  };

  if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', wire);
  else wire();
})(typeof self !== 'undefined' ? self : this);
