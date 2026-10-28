# Adulting Confessions & Group Chat Court 🍷

A real-time multiplayer party/drinking game for phones. Everyone opens the same link,
types a name and a 4-letter room code (no login, no account, no install), and every phone
shows the same synced screen: prompt, answers, votes, countdown, and sip tally.

## Modes
- **🤫 Adulting Confessions**: secret answers → anonymous reveal → everyone guesses who wrote
  each → you sip once per person who guessed you right (correct guessers +1 ⭐, unguessed author +2 ⭐).
- **⚖️ Group Chat Court**: "Most likely to…" vote → accused gets a 30 s countdown to defend
  (or "Just drink", 1 sip) → jury votes Drink (2 sips) or Acquit (accusers drink 1).
- **🃏 Wild Cards**: stacking rules, auto-drawn ~35% of rounds (host can draw or clear anytime).
- Host picks Alternate / Confessions only / Court only, or starts a specific round.
- Built-in "How to play" (❓) and step-by-step instructions on every phase.
- 50 confession prompts, 46 court accusations, 15 wild cards. Edit them in `prompts.js`.

## Run
```bash
./start.sh            # starts node server on :3000 + a Cloudflare quick tunnel, prints public URL
# or just the server:
npm start             # http://localhost:3000
node test.js http://localhost:3000   # 3-client end-to-end test (~35 s)
```
`start.sh` writes `server.log`, `tunnel.log`, and `public-url.txt`. Quick-tunnel URLs
(`*.trycloudflare.com`) are temporary: a new random URL every restart.
Cloudflare quick tunnels need outbound access to Cloudflare's edge on port 7844.

Env knobs: `PORT`, `T_ANSWER`, `T_GUESS`, `T_VOTE`, `T_DEFENSE`, `T_JUDGE` (seconds), `WILD_CHANCE` (0–1).

## Files
- `server.js`: Express + socket.io game server (state machine, timers, reconnects)
- `public/index.html`: mobile-first client (single file)
- `prompts.js`: all content
- `test.js`: end-to-end test with 3 simulated phones

## Deploy on Render (free)
`render.yaml` defines a free Node web service (`adulting-confessions`): build `npm ci --omit=dev`,
start `node server.js`, health check `/health`. The server binds `process.env.PORT`.
Push this folder to a GitHub repo that Render can reach, then create the web service from it
(or use the Blueprint). Free instances spin down after ~15 min idle and take ~30–60 s to wake;
rooms live in memory, so a spin-down or redeploy ends any game in progress.
Verify: `node test.js https://<service>.onrender.com`
