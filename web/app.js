const $ = id => document.getElementById(id);
let socket, actor = '', joined = false, muted = true, audio, heard = 0, reconnect;
const active = new Set();
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
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
function soundLabel() { $('sound').textContent = muted ? '◌ Sound off' : '♫ Sound on'; }
async function join(withSound) {
  if (withSound) {
    try { await enableAudio(); muted = false; }
    catch { $('notice').textContent = 'Audio is unavailable. You can still watch the live stream.'; }
  }
  joined = true; $('tutorial').close(); $('sound').disabled = false; soundLabel(); controls();
}
document.querySelectorAll('[data-preview]').forEach(button => button.addEventListener('click', async () => {
  try { await enableAudio(); sound(button.dataset.preview); button.classList.add('played'); }
  catch { button.querySelector('span').textContent = 'Audio unavailable in this browser.'; }
}));
$('join').onclick = () => join(true);
$('silent').onclick = () => join(false);
$('tutorial').addEventListener('cancel', e => { e.preventDefault(); join(false); });
$('sound').onclick = async () => {
  try { await enableAudio(); muted = !muted; soundLabel(); }
  catch { $('notice').textContent = 'Your browser could not start audio.'; }
};
function controls() {
  const ready = joined && socket?.readyState === WebSocket.OPEN && !!actor;
  $('insert').disabled = $('delete').disabled = !ready;
  $('composer').querySelector('button').disabled = !ready;
}
function send(command) {
  if (socket?.readyState !== WebSocket.OPEN || !actor) { $('notice').textContent = 'Reconnecting. Please try again when connected.'; return false; }
  socket.send(JSON.stringify(command)); $('notice').textContent = 'Sent to Postgres. Listening for the commit…'; return true;
}
$('insert').onclick = () => { $('composer').hidden = !$('composer').hidden; if (!$('composer').hidden) $('message').focus(); };
$('composer').onsubmit = e => { e.preventDefault(); const body = $('message').value.trim(); if (body && send({type: 'insert', body})) { $('message').value = ''; $('composer').hidden = true; } };
$('delete').onclick = () => send({type: 'delete'});
function show(e) {
  heard++; $('count').textContent = `${heard} CHANGES RECEIVED`; $('lsn').textContent = `LSN ${e.lsn}`;
  if (!muted) sound(e.type);
  const you = e.actor === actor;
  if (you) { $('notice').textContent = `Your ${e.type} committed. Now everyone can hear it.`; $('accessible-event').textContent = `Your ${e.type}: ${e.body}`; }
  const card = document.createElement('div'); card.className = `event ${e.type}${you ? ' you' : ''}`;
  const icon = document.createElement('b'); icon.textContent = {insert: '+', update: '↻', delete: '−'}[e.type];
  const content = document.createElement('div'); content.className = 'body';
  const label = document.createElement('small'); label.textContent = `${you ? 'YOU' : e.actor === 'house' ? 'HOUSE BAND' : 'LISTENER ' + e.actor.slice(0, 4)} · ${e.type.toUpperCase()} · #${e.id}`;
  content.append(label, document.createTextNode(e.body)); card.append(icon, content); $('stream').append(card);
  active.add(card);
  const remove = () => { active.delete(card); card.remove(); };
  if (active.size > 45) { const oldest = active.values().next().value; oldest.remove(); active.delete(oldest); }
  if (reducedMotion) { card.style.left = '110px'; setTimeout(remove, 2200); }
  else {
    const animation = card.animate([{transform: `translateX(${$('stream').clientWidth}px)`}, {transform: 'translateX(-380px)'}], {duration: 11000, easing: 'linear'});
    animation.onfinish = remove;
  }
}
document.addEventListener('visibilitychange', () => { for (const card of active) card.remove(); active.clear(); });
function connect() {
  clearTimeout(reconnect);
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  socket.onmessage = message => {
    let e; try { e = JSON.parse(message.data); } catch { return; }
    if (e.type === 'hello') { actor = e.actor; $('status').textContent = 'CONNECTED'; $('light').classList.add('connected'); controls(); return; }
    if (e.type === 'error') { $('notice').textContent = e.error; return; }
    if (joined && !document.hidden && ['insert', 'update', 'delete'].includes(e.type)) {
      show(e);
    }
  };
  socket.onclose = () => { actor = ''; controls(); $('status').textContent = 'RECONNECTING'; $('light').classList.remove('connected'); reconnect = setTimeout(connect, 1500); };
  socket.onerror = () => socket.close();
}
$('tutorial').showModal(); connect();
