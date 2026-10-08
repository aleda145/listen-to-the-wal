const $ = id => document.getElementById(id);
let socket, actor = '', muted = true, audio, reconnect, noticeTimer, lane = 0;
let transport = 'reconnecting', latestStats, recentEvents = [], retryDelay = 1500, lastReceived = 0;
async function enableAudio() {
  audio ||= new (window.AudioContext || window.webkitAudioContext)();
  await audio.resume();
}
function sound(type) {
  if (!audio || audio.state !== 'running') return;
  const now = audio.currentTime;
  const notes = type === 'insert' ? [523.25, 783.99] : type === 'update' ? [392, 493.88, 587.33] : [130.81];
  notes.forEach((frequency, i) => {
    const osc = audio.createOscillator(), gain = audio.createGain();
    const start = now + i * .065;
    osc.type = type === 'delete' ? 'triangle' : 'sine';
    osc.frequency.setValueAtTime(frequency, start);
    if (type === 'delete') osc.frequency.exponentialRampToValueAtTime(48, start + .3);
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(.09 / notes.length, start + .012);
    gain.gain.exponentialRampToValueAtTime(.001, start + .4);
    osc.connect(gain); gain.connect(audio.destination); osc.start(start); osc.stop(start + .42);
  });
}

function notice(message) {
  clearTimeout(noticeTimer);
  $('notice').textContent = message;
  $('notice').hidden = false;
  noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 5000);
}
$('sound').onclick = async () => {
  try {
    await enableAudio();
    muted = !muted;
    $('sound').setAttribute('aria-pressed', String(!muted));
    $('sound').setAttribute('aria-label', muted ? 'Enable sound' : 'Mute sound');
    $('sound').title = muted ? 'Enable sound' : 'Mute sound';
  } catch { notice('Audio unavailable.'); }
};
function controls() {
  const ready = socket?.readyState === WebSocket.OPEN && !!actor;
  $('insert').disabled = $('delete').disabled = $('message').disabled = !ready;
}
function send(command) {
  if (socket?.readyState !== WebSocket.OPEN || !actor) { notice('Reconnecting…'); return false; }
  socket.send(JSON.stringify(command));
  $('notice').hidden = true;
  return true;
}
$('composer').onsubmit = e => {
  e.preventDefault();
  const body = $('message').value.trim();
  if (body && send({type: 'insert', body})) { $('message').value = ''; $('message').focus(); }
};
$('delete').onclick = () => send({type: 'delete'});
function show(e) {
  if (!muted) sound(e.type);
  const message = document.createElement('div');
  message.className = `event ${e.type}${e.actor === actor ? ' you' : ''}`;
  const body = document.createElement('div');
  body.textContent = e.body;
  const metadata = document.createElement('div');
  metadata.className = 'event-meta';
  const date = new Date(e.timestamp);
  const timestamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  metadata.textContent = `ID ${e.id} · IP ${e.ip || (e.actor === 'house' ? 'server' : 'unknown')} · ${timestamp}`;
  metadata.title = `WAL read at ${e.timestamp}`;
  message.append(body, metadata);
  message.style.top = `${15 + (lane++ % 7) * 9}%`;
  $('stream').append(message);
  const width = message.getBoundingClientRect().width;
  const distance = $('stream').clientWidth + width + 40;
  const animation = message.animate([
    {transform: `translateX(${$('stream').clientWidth + 20}px)`},
    {transform: `translateX(${-width - 20}px)`}
  ], {duration: distance / 110 * 1000, easing: 'linear'});
  animation.onfinish = () => message.remove();
}
function connectionStatus() {
  const status = transport === 'connected' ? (latestStats?.status || 'reconnecting') : transport;
  $('connection-status').textContent = status;
  $('connection-status').dataset.status = status;
  $('connection-status').title = `WebSocket: ${transport}; WAL: ${latestStats?.status || 'unavailable'}`;
  $('metrics').classList.toggle('stale', status !== 'connected');
  const lag = latestStats?.replicationLag;
  $('lag-dial').style.setProperty('--dial', `${-135 + Math.min(1, Math.log10(1 + Math.max(0, lag || 0)) / 9) * 270}deg`);
  $('events-rate').textContent = status === 'connected' && latestStats ? latestStats.eventsPerSecond.toFixed(1) : '—';
  $('replication-lag').textContent = status === 'connected' && latestStats?.replicationLag != null ? latestStats.replicationLag.toLocaleString() : '—';
}
function renderRecent() {
  $('recent-count').textContent = `${recentEvents.length} / 50`;
  const rows = document.createDocumentFragment();
  for (const e of [...recentEvents].reverse()) {
    const row = document.createElement('tr'); row.className = e.type;
    const characters = Array.from(e.body);
    const excerpt = characters.length > 20 ? characters.slice(0, 19).join('') + '…' : e.body;
    const date = new Date(e.timestamp);
    const timestamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    for (const text of [timestamp, e.type.toUpperCase(), excerpt, e.lsn, e.ip || (e.actor === 'house' ? 'server' : 'unknown')]) {
      const cell = document.createElement('td'); cell.textContent = text; row.append(cell);
    }
    row.firstChild.title = `WAL read at ${e.timestamp}`;
    row.children[2].title = e.body;
    row.children[2].setAttribute('aria-label', e.body);
    row.children[3].title = e.lsn;
    row.children[4].title = e.ip || (e.actor === 'house' ? 'server' : 'unknown');
    rows.append(row);
  }
  $('recent-events').replaceChildren(rows);
}
function renderStats(stats) {
  latestStats = stats;
  connectionStatus();
  $('total-events').textContent = stats.totalEvents.toLocaleString();
  $('total-dial').style.setProperty('--dial', `${-135 + Math.min(1, Math.log10(1 + stats.totalEvents) / 6) * 270}deg`);
  recentEvents = stats.recent.slice(-50);
  renderRecent();
  const end = Date.parse(stats.timestamp);
  const points = stats.activity.filter(point => Date.parse(point.timestamp) > end - 60000).slice(-60);
  const peak = Math.max(0, ...points.map(point => point.eventsPerSecond));
  const scale = Math.max(1, peak);
  $('rate-dial').style.setProperty('--dial', `${-135 + Math.min(1, stats.eventsPerSecond / scale) * 270}deg`);
  const path = points.map((point, index) => {
    const x = Math.max(0, Math.min(300, (Date.parse(point.timestamp) - end + 60000) / 60000 * 300));
    const y = 58 - point.eventsPerSecond / scale * 54;
    return `${index ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  $('activity-line').setAttribute('d', path);
  $('chart-scale').textContent = `0–${scale.toFixed(1)}`;
  $('activity-chart').setAttribute('aria-label', `Events per second, last 60 seconds. Peak ${peak.toFixed(1)}.`);
}
function connect() {
  clearTimeout(reconnect);
  transport = 'reconnecting'; connectionStatus();
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  lastReceived = Date.now();
  socket.onmessage = message => {
    lastReceived = Date.now();
    let e; try { e = JSON.parse(message.data); } catch { return; }
    if (e.type === 'hello') {
      actor = e.actor; transport = 'connected'; latestStats = null; retryDelay = 1500;
      connectionStatus(); controls(); return;
    }
    if (e.type === 'stats') { renderStats(e.stats); return; }
    if (e.type === 'error') { notice(e.error); return; }
    if (['insert', 'update', 'delete'].includes(e.type)) {
      recentEvents.push(e); if (recentEvents.length > 50) recentEvents.shift();
      renderRecent();
      show(e);
    }
  };
  socket.onclose = () => {
    actor = ''; transport = 'disconnected'; controls(); connectionStatus();
    reconnect = setTimeout(connect, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 15000);
  };
  socket.onerror = () => socket.close();
}
// Detect a half-open connection even when the browser receives no close frame.
setInterval(() => {
  if (socket && socket.readyState !== WebSocket.CLOSED && Date.now() - lastReceived > 10000) {
    transport = 'disconnected'; actor = ''; controls(); connectionStatus(); socket.close();
  }
}, 1000);
connect();
