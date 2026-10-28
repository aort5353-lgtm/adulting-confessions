// End-to-end test: 3 simulated phones play one Confessions + one Court round.
// Usage: node test.js [baseUrl]
const { io } = require('socket.io-client');
const URL = process.argv[2] || 'http://localhost:3000';
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } console.log('  ok -', m); };
const mk = (n) => { const s = io(URL, { transports: ['websocket'] }); const c = { name: n, id: n + Math.random().toString(36).slice(2), s, st: null }; s.on('state', x => c.st = x); s.on('err', e => console.log('  err', n, e)); return c; };
const wait = (pred, ms = 15000, label = '') => new Promise((res, rej) => { const t0 = Date.now(); const iv = setInterval(() => { if (pred()) { clearInterval(iv); res(); } else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error('timeout ' + label)); } }, 50); });
(async () => {
  const [A, B, C] = [mk('Allie'), mk('Bea'), mk('Cam')]; const all = [A, B, C];
  await wait(() => all.every(c => c.s.connected), 10000, 'connect');
  A.s.emit('create', { name: A.name, playerId: A.id });
  await wait(() => A.st, 5000, 'create'); const code = A.st.code; console.log('Room', code);
  B.s.emit('join', { code, name: B.name, playerId: B.id }); C.s.emit('join', { code, name: C.name, playerId: C.id });
  await wait(() => all.every(c => c.st && c.st.players.length === 3), 5000, 'join');
  assert(all.every(c => c.st.code === code && c.st.host === A.id), 'all 3 joined, Allie is host');

  // ---- Confessions ----
  A.s.emit('start', 'conf');
  await wait(() => all.every(c => c.st.phase === 'conf_answer'), 5000, 'conf_answer');
  const p = A.st.round.prompt; assert(all.every(c => c.st.round.prompt === p), 'same confession prompt on every phone: "' + p + '"');
  const ends = all.map(c => c.st.endsAt); assert(ends.every(e => e === ends[0] && e > Date.now() - 5000), 'answer timer synced (same endsAt)');
  const ans = { [A.id]: 'Hid in the pantry eating cheese', [B.id]: 'Fake Costco run', [C.id]: 'Pretended the toilet was broken' };
  for (const c of all) c.s.emit('answer', ans[c.id]);
  await wait(() => all.every(c => c.st.phase === 'conf_guess'), 5000, 'conf_guess');
  const cards = A.st.round.cards; assert(cards.length === 3 && all.every(c => JSON.stringify(c.st.round.cards.map(x => x.text)) === JSON.stringify(cards.map(x => x.text))), 'same anonymous shuffled answers on every phone');
  assert(!JSON.stringify(B.st).includes('"author"'), 'authors hidden during guessing');
  const byText = Object.fromEntries(Object.entries(ans).map(([k, v]) => [v, k]));
  // Bea and Cam guess everything right; Allie guesses everything wrong
  for (const c of all) { const g = {}; for (const card of c.st.round.cards) { if (card.mine) continue; const truth = byText[card.text]; g[card.id] = c === A ? all.find(x => x.id !== truth && x !== A).id : truth; } c.s.emit('guess', g); }
  await wait(() => all.every(c => c.st.phase === 'conf_reveal'), 5000, 'conf_reveal');
  const res = A.st.round.results; assert(all.every(c => JSON.stringify(c.st.round.results) === JSON.stringify(res)), 'same reveal on every phone');
  const sips = Object.fromEntries(A.st.players.map(x => [x.name, x.sips]));
  console.log('  sips after confessions', sips);
  assert(sips.Allie === 2 && sips.Bea === 1 && sips.Cam === 1, 'sip tally correct (Allie guessed by 2, Bea & Cam by 1 each)');

  // ---- Court ----
  A.s.emit('start', 'court');
  await wait(() => all.every(c => c.st.phase === 'court_vote'), 5000, 'court_vote');
  assert(all.every(c => c.st.round.prompt === A.st.round.prompt), 'same accusation on every phone: "' + A.st.round.prompt + '"');
  A.s.emit('vote', B.id); C.s.emit('vote', B.id); B.s.emit('vote', A.id);
  await wait(() => all.every(c => c.st.phase === 'court_defense'), 5000, 'court_defense');
  assert(all.every(c => c.st.round.guilty === B.id), 'Bea found guilty on every phone (2 votes)');
  const de = all.map(c => c.st.endsAt); const secs = (de[0] - A.st.serverNow) / 1000;
  assert(de.every(e => e === de[0]) && secs > 28 && secs <= 30.5, 'defense countdown synced, ' + secs.toFixed(1) + 's');
  console.log('  waiting for 30s defense timer to expire on its own...');
  await wait(() => all.every(c => c.st.phase === 'court_judge'), 40000, 'court_judge');
  assert(true, 'server auto-advanced to jury after the countdown');
  A.s.emit('judge', 'drink'); C.s.emit('judge', 'drink');
  await wait(() => all.every(c => c.st.phase === 'court_done'), 5000, 'court_done');
  assert(all.every(c => c.st.round.outcome.verdict === 'guilty'), 'verdict GUILTY on every phone');
  const s2 = Object.fromEntries(A.st.players.map(x => [x.name, x.sips])); console.log('  sips after court', s2);
  assert(s2.Bea === 3, 'Bea +2 sips');

  // reconnect check
  B.s.disconnect(); const B2 = mk('Bea'); B2.id = B.id; await wait(() => B2.s.connected); B2.s.emit('join', { code, playerId: B.id, name: '', rejoin: true });
  await wait(() => B2.st && B2.st.phase === 'court_done', 5000, 'rejoin'); assert(B2.st.players.find(x => x.id === B.id).sips === 3, 'reconnecting phone gets its state back');
  console.log('ALL TESTS PASSED'); process.exit(0);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
