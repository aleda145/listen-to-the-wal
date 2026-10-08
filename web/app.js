const $ = id => document.getElementById(id);
let socket, actor = '', muted = true, audio, reconnect, noticeTimer;
const noteLanes = {insert: {next: 0, available: []}, update: {next: 0, available: []}, delete: {next: 0, available: []}};
let currentRows = new Map(), messageOrder = 'top', leaderboardSignature = '';
let transport = 'reconnecting', latestStats, retryDelay = 1500, lastReceived = 0;
async function enableAudio() {
  audio ||= new (window.AudioContext || window.webkitAudioContext)();
  await audio.resume();
}
function sound(type) {
  if (!audio || audio.state !== 'running') return;
  const now = audio.currentTime;
  // INSERT: kick, UPDATE: snare, DELETE: closed hi-hat.
  if (type === 'insert' || type === 'update') {
    const osc = audio.createOscillator(), gain = audio.createGain();
    const duration = type === 'insert' ? .32 : .12;
    osc.frequency.setValueAtTime(type === 'insert' ? 150 : 180, now);
    osc.frequency.exponentialRampToValueAtTime(type === 'insert' ? 42 : 70, now + duration);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(type === 'insert' ? .35 : .14, now + .004);
    gain.gain.exponentialRampToValueAtTime(.001, now + duration);
    osc.connect(gain); gain.connect(audio.destination);
    osc.start(now); osc.stop(now + duration);
  }
  if (type === 'update' || type === 'delete') {
    const duration = type === 'update' ? .18 : .065;
    const buffer = audio.createBuffer(1, Math.ceil(audio.sampleRate * duration), audio.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
    const noise = audio.createBufferSource(), filter = audio.createBiquadFilter(), gain = audio.createGain();
    noise.buffer = buffer;
    filter.type = 'highpass';
    filter.frequency.value = type === 'update' ? 1200 : 7000;
    gain.gain.setValueAtTime(type === 'update' ? .22 : .15, now);
    gain.gain.exponentialRampToValueAtTime(.001, now + duration);
    noise.connect(filter); filter.connect(gain); gain.connect(audio.destination);
    noise.start(now); noise.stop(now + duration);
  }
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
  $('insert').disabled = $('message').disabled = !ready;
  for (const button of $('message-list').querySelectorAll('button')) {
    button.disabled = !ready || !latestStats;
  }
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
  if (Array.from(body).length > 10) { notice('Write between 1 and 10 characters.'); return; }
  if (body && send({type: 'insert', body})) { $('message').value = ''; $('message').focus(); }
};
for (const order of ['top', 'new']) {
  $(order + '-tab').onclick = () => {
    messageOrder = order;
    for (const name of ['top', 'new']) {
      $(name + '-tab').setAttribute('aria-selected', String(name === order));
      $(name + '-tab').tabIndex = name === order ? 0 : -1;
    }
    $('leaderboard-panel').setAttribute('aria-labelledby', order + '-tab');
    renderLeaderboard();
    $('leaderboard-panel').scrollTop = 0;
  };
  $(order + '-tab').onkeydown = e => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const next = e.key === 'Home' ? 'top' : e.key === 'End' ? 'new' : order === 'top' ? 'new' : 'top';
    $(next + '-tab').click();
    $(next + '-tab').focus();
  };
}
function renderLeaderboard() {
  const rows = [...currentRows.values()].sort((a, b) =>
    messageOrder === 'top' ? b.score - a.score || b.id - a.id : b.id - a.id);
  $('message-count').textContent = `${rows.length} live`;
  $('leaderboard-empty').hidden = rows.length > 0;
  $('leaderboard-empty').textContent = latestStats ? 'No messages yet. Send the first one.' : 'Connecting…';
  const signature = JSON.stringify([messageOrder, rows.map(e => [e.id, e.body, e.score, e.ip, e.actor])]);
  if (signature === leaderboardSignature) { controls(); return; }
  leaderboardSignature = signature;
  const focused = document.activeElement;
  const focusID = focused?.closest('#message-list li')?.dataset.id;
  const focusAction = focused?.dataset.action;
  const expanded = new Set([...$('message-list').querySelectorAll('details[open]')].map(el => el.closest('li').dataset.id));
  const list = document.createDocumentFragment();
  for (const e of rows) {
    const row = document.createElement('li');
    row.dataset.id = e.id;
    const details = document.createElement('details');
    details.open = expanded.has(String(e.id));
    const title = document.createElement('summary');
    const characters = Array.from(e.body);
    title.textContent = characters.length > 10 ? characters.slice(0, 9).join('') + '…' : e.body;
    title.title = e.body;
    const metadata = document.createElement('p');
    metadata.className = 'row-meta';
    metadata.textContent = `ID ${e.id} · IP ${e.ip || (e.actor === 'house' ? 'server' : 'unknown')}`;
    details.append(title, metadata);
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    const score = document.createElement('span');
    score.className = 'row-score';
    score.textContent = `${e.score} points`;
    actions.append(score);
    for (const [action, label] of [['upvote', '▲'], ['downvote', '▼'], ['delete', 'Delete']]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.dataset.action = action;
      button.title = `${action === 'upvote' ? 'Upvote' : action === 'downvote' ? 'Downvote' : 'Delete'} message ${e.id}`;
      button.setAttribute('aria-label', button.title);
      button.onclick = () => send({type: action, id: e.id});
      actions.append(button);
    }
    row.append(details, actions);
    list.append(row);
  }
  $('message-list').replaceChildren(list);
  controls();
  if (focusID) {
    const row = $('message-list').querySelector(`li[data-id="${focusID}"]`);
    const target = focusAction ? row?.querySelector(`button[data-action="${focusAction}"]`) : row?.querySelector('summary');
    (target || $('leaderboard-panel')).focus({preventScroll: true});
  }
}
function show(e) {
  const track = $(e.type + '-track');
  const slots = Math.max(1, Math.floor(track.clientWidth / 130));
  const lanes = noteLanes[e.type];
  const slot = lanes.next++ % slots;
  const now = performance.now();
  const start = Math.max(now, lanes.available[slot] || 0);
  const duration = 3200;
  // Spread bursts across the track, then space overflow vertically. Never drop notes.
  lanes.available[slot] = start + duration * 58 / Math.max(58, track.clientHeight);
  const message = document.createElement('div');
  message.className = `event ${e.type}`;
  message.style.left = `${(slot + .5) / slots * 100}%`;
  message.style.width = `calc(${100 / slots}% - 10px)`;
  message.title = `${e.type.toUpperCase()} · ${e.body}`;
  const body = document.createElement('span');
  body.className = 'event-body';
  const characters = Array.from(e.body);
  body.textContent = characters.length > 10 ? characters.slice(0, 9).join('') + '…' : e.body;
  message.setAttribute('aria-label', `${e.type}: ${e.body}`);
  message.append(body);
  track.append(message);
  const animation = message.animate([
    {top: '-44px'},
    {top: 'calc(100% - 44px)'}
  ], {duration, delay: start - now, easing: 'linear', fill: 'both'});
  animation.onfinish = () => {
    // Only the actual landing triggers audio; this note came from a WAL event.
    if (!muted) sound(e.type);
    const instrument = $(e.type + '-instrument');
    instrument.getAnimations().forEach(hit => hit.cancel());
    instrument.animate([
      {transform: 'translateY(4px) scaleY(.9)', filter: 'brightness(2.2)'},
      {transform: 'translateY(0) scaleY(1)', filter: 'brightness(1)'}
    ], {duration: 200, easing: 'ease-out'});
    const ripple = document.createElement('span');
    ripple.className = `hit-ripple ${e.type}`;
    ripple.style.left = `${(slot + .5) / slots * 100}%`;
    track.append(ripple);
    ripple.animate([
      {transform: 'translate(-50%, 50%) scale(.3)', opacity: 1},
      {transform: 'translate(-50%, 50%) scale(2)', opacity: 0}
    ], {duration: 240, fill: 'forwards'}).onfinish = () => ripple.remove();
    message.remove();
  };
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
function renderJoyPlot(stats) {
  const now = Date.parse(stats.timestamp);
  const start = now - 30000;
  const samples = stats.activity.filter(point => {
    const at = Date.parse(point.timestamp);
    return at > start && at <= now;
  });
  const metrics = [
    ['eventsPerSecond', 'All events', '/ sec'],
    ['insertsPerSecond', 'Inserts', '/ sec'],
    ['updatesPerSecond', 'Updates', '/ sec'],
    ['deletesPerSecond', 'Deletes', '/ sec'],
    ['replicationLag', 'WAL lag', 'bytes']
  ];
  const ridges = document.createDocumentFragment();
  const labels = document.createDocumentFragment();
  const descriptions = [];
  for (const [row, [metric, name, unit]] of metrics.entries()) {
    const values = samples.map(point => ({
      at: Date.parse(point.timestamp),
      value: point.connected ? point[metric] : null
    }));
    // A light three-sample blend rounds 500 ms spikes without flattening bursts.
    const smoothed = values.map((point, index) => {
      if (point.value == null) return null;
      let sum = point.value * .6, weight = .6;
      for (const neighbor of [values[index - 1], values[index + 1]]) {
        if (neighbor?.value != null && Math.abs(neighbor.at - point.at) < 750) {
          sum += neighbor.value * .2;
          weight += .2;
        }
      }
      return sum / weight;
    });
    const known = values.filter(point => point.value != null);
    const peak = Math.max(0, ...known.map(point => point.value));
    const scale = Math.max(1, peak);
    const baseline = 126 + row * 18;
    const label = document.createElement('div');
    label.style.top = `${baseline / 250 * 100}%`;
    const nameLabel = document.createElement('strong');
    nameLabel.textContent = name;
    const peakLabel = document.createElement('span');
    peakLabel.textContent = known.length ? `peak ${peak.toLocaleString(undefined, {maximumFractionDigits: metric === 'replicationLag' ? 0 : 1})} ${unit}` : 'Awaiting data';
    label.title = `${name}: ${peakLabel.textContent}`;
    label.append(nameLabel, peakLabel);
    labels.append(label);
    descriptions.push(`${name}: ${peakLabel.textContent}`);
    // All five rows are present immediately; dashed portions mean missing data.
    const guide = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    guide.setAttribute('d', `M12,${baseline}H588`);
    guide.setAttribute('stroke', '#555');
    guide.setAttribute('stroke-dasharray', '2 5');
    guide.setAttribute('vector-effect', 'non-scaling-stroke');
    ridges.append(guide);
    for (let i = 0; i < values.length; i++) {
      if (values[i].value == null) continue;
      const first = i;
      // Plot actual timestamps. Timer jitter must not create empty one-second bins.
      while (i + 1 < values.length && values[i + 1].value != null && values[i + 1].at - values[i].at < 1250) i++;
      const last = i;
      const left = first === 0 ? 12 : 12 + (values[first].at - start) / 30000 * 576;
      let line = first === 0 ? `M12,${baseline} H${Math.min(69.6, 12 + (values[first].at - start) / 30000 * 576)} ` : '';
      const points = [];
      for (let j = first; j <= last; j++) {
        const progress = (values[j].at - start) / 30000;
        const x = 12 + progress * 576;
        // Flat outer 10%, then a smooth taper into the full-height middle.
        const edge = Math.max(0, Math.min(1, (Math.min(progress, 1 - progress) - .1) / .15));
        const envelope = edge * edge * (3 - 2 * edge);
        const y = baseline - smoothed[j] / scale * 106 * envelope;
        points.push({x, y});
      }
      line += `${line ? 'L' : 'M'}${points[0].x.toFixed(2)},${points[0].y.toFixed(2)} `;
      for (let j = 0; j < points.length - 1; j++) {
        const point = points[j], next = points[j + 1];
        line += `Q${point.x.toFixed(2)},${point.y.toFixed(2)} ${((point.x + next.x) / 2).toFixed(2)},${((point.y + next.y) / 2).toFixed(2)} `;
      }
      const finalPoint = points[points.length - 1];
      line += `L${finalPoint.x.toFixed(2)},${finalPoint.y.toFixed(2)} `;
      // Hold the latest sample only until the next expected tick.
      const end = Math.min(now, values[last].at + 500);
      let right = 12 + (end - start) / 30000 * 576;
      if (last === values.length - 1) {
        line += `L${Math.max(530.4, right).toFixed(2)},${baseline} H588 `;
        right = 588;
      } else {
        line += `H${right.toFixed(2)} `;
      }
      const fill = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      fill.setAttribute('d', `${line}L${right},${baseline} L${left},${baseline} Z`);
      fill.setAttribute('fill', '#101010');
      ridges.append(fill);
      const stroke = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      stroke.setAttribute('d', line);
      stroke.setAttribute('fill', 'none');
      stroke.setAttribute('stroke', '#f7f3e8');
      stroke.setAttribute('stroke-width', '1.3');
      stroke.setAttribute('stroke-linejoin', 'round');
      stroke.setAttribute('vector-effect', 'non-scaling-stroke');
      ridges.append(stroke);
    }
  }
  $('joy-ridges').replaceChildren(ridges);
  $('joy-labels').replaceChildren(labels);
  $('joy-chart').setAttribute('aria-label', `All five signals over the same last 30 seconds. Each ridge scaled to its own peak with decorative tapering to zero at both ends. ${descriptions.join('. ')}. Dashed lines indicate missing data.`);
  const eventPeak = Math.max(1, ...samples.map(point => point.eventsPerSecond));
  $('rate-dial').style.setProperty('--dial', `${-135 + Math.min(1, stats.eventsPerSecond / eventPeak) * 270}deg`);
}
renderJoyPlot({timestamp: new Date().toISOString(), activity: [], eventsPerSecond: 0});

function renderStats(stats) {
  latestStats = stats;
  currentRows = new Map(stats.rows.map(row => [row.id, row]));
  renderLeaderboard();
  connectionStatus();
  $('total-events').textContent = stats.totalEvents.toLocaleString();
  $('total-dial').style.setProperty('--dial', `${-135 + Math.min(1, Math.log10(1 + stats.totalEvents) / 6) * 270}deg`);
  renderJoyPlot(stats);
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
      if (e.type === 'delete') {
        currentRows.delete(e.id);
      } else {
        currentRows.set(e.id, e);
      }
      renderLeaderboard();
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
