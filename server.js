const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const P = require('./prompts');

const PORT = process.env.PORT || 3000;
const T = { // phase timers in seconds
  answer: +process.env.T_ANSWER || 75,
  guess: +process.env.T_GUESS || 60,
  vote: +process.env.T_VOTE || 30,
  defense: +process.env.T_DEFENSE || 30,
  judge: +process.env.T_JUDGE || 20,
};
const WILD_CHANCE = process.env.WILD_CHANCE !== undefined ? +process.env.WILD_CHANCE : 0.35;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_, res) => res.json({ ok: true, rooms: rooms.size }));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const rooms = new Map();
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const genCode = () => { let c; do { c = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(Math.random() * 24)]).join(''); } while (rooms.has(c)); return c; };

function draw(room, key) {
  if (!room.decks[key] || room.decks[key].length === 0) room.decks[key] = shuffle(P[key]);
  return room.decks[key].pop();
}

function publicState(room, pid) {
  const r = room.round;
  const players = room.order.map(id => { const p = room.players[id]; return { id, name: p.name, sips: p.sips, points: p.points, connected: p.connected, isHost: id === room.host }; });
  const s = { code: room.code, host: room.host, you: pid, players, phase: room.phase, mode: room.modePref, nextMode: room.nextMode, rules: room.rules, newRule: room.newRule, roundNo: room.roundNo, endsAt: room.endsAt, serverNow: Date.now(), log: room.log.slice(-6) };
  if (!r) return s;
  s.round = { type: r.type, prompt: r.prompt };
  if (r.type === 'conf') {
    s.round.answeredIds = Object.keys(r.answers);
    s.round.myAnswer = r.answers[pid] || null;
    if (room.phase === 'conf_guess' || room.phase === 'conf_reveal') {
      s.round.cards = r.cards.map(c => ({ id: c.id, text: c.text, mine: c.author === pid }));
      s.round.guessedIds = Object.keys(r.guesses);
      s.round.myGuesses = r.guesses[pid] || null;
    }
    if (room.phase === 'conf_reveal') s.round.results = r.results;
  } else {
    s.round.votedIds = Object.keys(r.votes);
    s.round.myVote = r.votes[pid] || null;
    if (['court_defense', 'court_judge', 'court_done'].includes(room.phase)) { s.round.tally = r.tally; s.round.guilty = r.guilty; s.round.tie = r.tie; }
    if (room.phase === 'court_judge' || room.phase === 'court_done') { s.round.judgedIds = Object.keys(r.judgments); s.round.myJudgment = r.judgments[pid] || null; }
    if (room.phase === 'court_done') s.round.outcome = r.outcome;
  }
  return s;
}

function broadcast(room) {
  for (const id of room.order) { const p = room.players[id]; if (p.socket) p.socket.emit('state', publicState(room, id)); }
}

function setTimer(room, secs, fn) {
  clearTimeout(room.timer);
  room.endsAt = Date.now() + secs * 1000;
  room.timer = setTimeout(() => { room.endsAt = null; fn(); broadcast(room); }, secs * 1000);
}
function clearTimer(room) { clearTimeout(room.timer); room.endsAt = null; }
const log = (room, msg) => room.log.push(msg);
const active = room => room.order.filter(id => room.players[id].connected);

function startRound(room, forced) {
  const type = forced || room.nextMode;
  room.roundNo++;
  room.newRule = null;
  if (room.roundNo > 1 && Math.random() < WILD_CHANCE) {
    const card = draw(room, 'wildCards');
    if (!room.rules.includes(card)) { room.rules.push(card); room.newRule = card; }
  }
  if (type === 'conf') {
    room.round = { type, prompt: draw(room, 'confessions'), answers: {}, guesses: {}, participants: active(room) };
    room.phase = 'conf_answer';
    setTimer(room, T.answer, () => toGuess(room));
  } else {
    room.round = { type, prompt: draw(room, 'court'), votes: {}, judgments: {}, participants: active(room) };
    room.phase = 'court_vote';
    setTimer(room, T.vote, () => toVerdict(room));
  }
  room.nextMode = room.modePref === 'alt' ? (type === 'conf' ? 'court' : 'conf') : room.modePref;
}

function toGuess(room) {
  const r = room.round;
  if (Object.keys(r.answers).length < 2) { // not enough answers - skip
    log(room, 'Not enough confessions came in. Skipping round.');
    room.phase = 'lobby'; room.round = null; clearTimer(room); return;
  }
  r.cards = shuffle(Object.entries(r.answers).map(([author, text], i) => ({ id: 'c' + i, author, text })));
  room.phase = 'conf_guess';
  setTimer(room, T.guess, () => toReveal(room));
}

function toReveal(room) {
  const r = room.round; clearTimer(room);
  r.results = r.cards.map(c => {
    const correct = [], wrong = [];
    for (const [gid, g] of Object.entries(r.guesses)) {
      if (gid === c.author || !g[c.id]) continue;
      (g[c.id] === c.author ? correct : wrong).push(gid);
    }
    correct.forEach(g => room.players[g] && room.players[g].points++);
    if (room.players[c.author]) room.players[c.author].sips += correct.length;
    return { id: c.id, text: c.text, author: c.author, correct, wrong, sips: correct.length };
  });
  // nobody guessed you at all = sneaky bonus point
  r.results.forEach(x => { if (x.correct.length === 0 && room.players[x.author]) room.players[x.author].points += 2; });
  room.phase = 'conf_reveal';
}

function toVerdict(room) {
  const r = room.round; clearTimer(room);
  const tally = {};
  Object.values(r.votes).forEach(v => tally[v] = (tally[v] || 0) + 1);
  const max = Math.max(0, ...Object.values(tally));
  if (max === 0) { log(room, 'Nobody voted. Court dismissed.'); room.phase = 'lobby'; room.round = null; return; }
  const top = Object.keys(tally).filter(k => tally[k] === max);
  r.tally = tally; r.tie = top.length > 1; r.guilty = top[Math.floor(Math.random() * top.length)];
  room.phase = 'court_defense';
  setTimer(room, T.defense, () => toJudge(room));
}

function toJudge(room) {
  room.phase = 'court_judge';
  setTimer(room, T.judge, () => toCourtDone(room));
}

function toCourtDone(room, pleaded) {
  const r = room.round; clearTimer(room);
  const g = room.players[r.guilty];
  if (pleaded) { r.outcome = { verdict: 'pleaded', sips: 1 }; }
  else {
    const vals = Object.values(r.judgments);
    const drink = vals.filter(v => v === 'drink').length, acquit = vals.filter(v => v === 'acquit').length;
    r.outcome = drink >= acquit ? { verdict: 'guilty', sips: 2, drink, acquit } : { verdict: 'acquitted', sips: 0, drink, acquit };
    if (r.outcome.verdict === 'acquitted') { // accusers who voted for them drink instead
      Object.entries(r.votes).forEach(([vid, t]) => { if (t === r.guilty && vid !== r.guilty && room.players[vid]) room.players[vid].sips++; });
      r.outcome.accusersDrink = true;
    }
  }
  if (g) g.sips += r.outcome.sips;
  room.phase = 'court_done';
}

function maybeAdvance(room) {
  const r = room.round; if (!r) return;
  const need = r.participants.filter(id => room.players[id] && room.players[id].connected);
  if (room.phase === 'conf_answer' && need.every(id => r.answers[id])) toGuess(room);
  else if (room.phase === 'conf_guess' && need.every(id => r.guesses[id])) toReveal(room);
  else if (room.phase === 'court_vote' && need.every(id => r.votes[id])) toVerdict(room);
  else if (room.phase === 'court_judge' && need.filter(id => id !== r.guilty).every(id => r.judgments[id])) toCourtDone(room);
}

io.on('connection', socket => {
  let room = null, pid = null;
  const err = m => socket.emit('err', m);

  socket.on('create', ({ name, playerId }) => {
    name = String(name || '').trim().slice(0, 16); if (!name) return err('Enter a name');
    const code = genCode();
    room = { code, host: playerId, players: {}, order: [], phase: 'lobby', round: null, roundNo: 0, rules: [], newRule: null, decks: {}, modePref: 'alt', nextMode: 'conf', log: [], endsAt: null };
    rooms.set(code, room);
    pid = playerId;
    room.players[pid] = { name, sips: 0, points: 0, connected: true, socket };
    room.order.push(pid);
    socket.join(code); broadcast(room);
  });

  socket.on('join', ({ code, name, playerId, rejoin }) => {
    code = String(code || '').trim().toUpperCase();
    const r = rooms.get(code); if (!r) return rejoin ? socket.emit('gone') : err('No room with code ' + code);
    if (rejoin && !r.players[playerId]) return socket.emit('gone');
    name = String(name || '').trim().slice(0, 16);
    if (r.players[playerId]) { // reconnect
      room = r; pid = playerId; const p = r.players[pid]; p.socket = socket; p.connected = true; if (name) p.name = name;
    } else {
      if (!name) return err('Enter a name');
      if (Object.values(r.players).some(p => p.name.toLowerCase() === name.toLowerCase())) return err('That name is taken in this room');
      if (r.order.length >= 16) return err('Room is full');
      room = r; pid = playerId;
      r.players[pid] = { name, sips: 0, points: 0, connected: true, socket };
      r.order.push(pid);
      if (r.round) r.round.participants.push(pid);
      log(r, name + ' joined');
    }
    socket.join(code); broadcast(room);
  });

  const guard = fn => (...a) => { if (!room || !pid) return; try { fn(...a); } catch (e) { console.error(e); } broadcast(room); };
  const isHost = () => room.host === pid;

  socket.on('setMode', guard(m => { if (!isHost() || !['alt', 'conf', 'court'].includes(m)) return; room.modePref = m; if (m !== 'alt') room.nextMode = m; }));
  socket.on('start', guard(forced => {
    if (!isHost()) return;
    if (!['lobby', 'conf_reveal', 'court_done'].includes(room.phase)) return;
    if (active(room).length < 3) return err('Need at least 3 players');
    startRound(room, ['conf', 'court'].includes(forced) ? forced : null);
  }));
  socket.on('answer', guard(text => {
    if (room.phase !== 'conf_answer') return; text = String(text || '').trim().slice(0, 200); if (!text) return;
    room.round.answers[pid] = text; maybeAdvance(room);
  }));
  socket.on('guess', guard(g => {
    if (room.phase !== 'conf_guess' || typeof g !== 'object') return;
    const clean = {}; for (const c of room.round.cards) if (c.author !== pid && room.players[g[c.id]]) clean[c.id] = g[c.id];
    room.round.guesses[pid] = clean; maybeAdvance(room);
  }));
  socket.on('vote', guard(target => { if (room.phase !== 'court_vote' || !room.players[target]) return; room.round.votes[pid] = target; maybeAdvance(room); }));
  socket.on('plead', guard(() => { if (room.phase === 'court_defense' && room.round.guilty === pid) toCourtDone(room, true); }));
  socket.on('rest', guard(() => { if (room.phase === 'court_defense' && (room.round.guilty === pid || isHost())) toJudge(room); }));
  socket.on('judge', guard(v => { if (room.phase !== 'court_judge' || pid === room.round.guilty || !['drink', 'acquit'].includes(v)) return; room.round.judgments[pid] = v; maybeAdvance(room); }));
  socket.on('skip', guard(() => { // host force-advances
    if (!isHost()) return;
    ({ conf_answer: toGuess, conf_guess: toReveal, court_vote: toVerdict, court_defense: toJudge, court_judge: r => toCourtDone(r) }[room.phase] || (() => {}))(room);
  }));
  socket.on('sip', guard(() => { room.players[pid].sips++; log(room, room.players[pid].name + ' took a sip 🍺'); }));
  socket.on('wild', guard(() => { if (!isHost()) return; const c = draw(room, 'wildCards'); if (!room.rules.includes(c)) { room.rules.push(c); room.newRule = c; } }));
  socket.on('clearRules', guard(() => { if (isHost()) { room.rules = []; room.newRule = null; } }));
  socket.on('dismissRule', guard(() => { room.newRule = null; }));
  socket.on('kick', guard(id => { if (!isHost() || id === pid || !room.players[id]) return; const p = room.players[id]; if (p.socket) p.socket.emit('kicked'); delete room.players[id]; room.order = room.order.filter(x => x !== id); maybeAdvance(room); }));

  socket.on('disconnect', () => {
    if (!room || !room.players[pid] || room.players[pid].socket !== socket) return;
    room.players[pid].connected = false; room.players[pid].socket = null;
    if (room.host === pid) { const next = room.order.find(id => room.players[id].connected); if (next) { room.host = next; log(room, room.players[next].name + ' is now host'); } }
    maybeAdvance(room); broadcast(room);
    if (!room.order.some(id => room.players[id].connected)) { const c = room.code, rr = room; setTimeout(() => { if (!rr.order.some(id => rr.players[id] && rr.players[id].connected)) { clearTimeout(rr.timer); rooms.delete(c); } }, 30 * 60 * 1000); }
  });
});

server.listen(PORT, () => console.log('Party game on :' + PORT));
