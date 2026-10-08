const $ = id => document.getElementById(id);
let socket, actor = '', muted = true, audio, reconnect, noticeTimer, lane = 0;
const active = new Set();
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
  message.textContent = e.body;
  message.style.top = `${15 + (lane++ % 7) * 9}%`;
  $('stream').append(message);
  active.add(message);
  if (active.size > 45) {
    const oldest = active.values().next().value;
    oldest.getAnimations().forEach(animation => animation.cancel());
    oldest.remove(); active.delete(oldest);
  }
  const width = message.getBoundingClientRect().width;
  const distance = $('stream').clientWidth + width + 40;
  const animation = message.animate([
    {transform: `translateX(${$('stream').clientWidth + 20}px)`},
    {transform: `translateX(${-width - 20}px)`}
  ], {duration: distance / 110 * 1000, easing: 'linear'});
  animation.onfinish = () => { active.delete(message); message.remove(); };
}
document.addEventListener('visibilitychange', () => {
  for (const message of active) { message.getAnimations().forEach(animation => animation.cancel()); message.remove(); }
  active.clear();
});
function connect() {
  clearTimeout(reconnect);
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  socket.onmessage = message => {
    let e; try { e = JSON.parse(message.data); } catch { return; }
    if (e.type === 'hello') { actor = e.actor; controls(); return; }
    if (e.type === 'error') { notice(e.error); return; }
    if (!document.hidden && ['insert', 'update', 'delete'].includes(e.type)) show(e);
  };
  socket.onclose = () => { actor = ''; controls(); reconnect = setTimeout(connect, 1500); };
  socket.onerror = () => socket.close();
}
connect();
