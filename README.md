# OutTime

A punch-in/punch-out tracker for hackathons: every team gets a fixed budget of "out time"
(default 7 hours), shared across all of that team's devices, and admins approve/reject
every Go Out / Enter request in real time. Built mobile-first — teams and admins alike are
expected to use this from a phone during the event.

## Architecture

- **Server**: Node.js + TypeScript, single process. Fastify for HTTP, `ws` for WebSockets.
  No ORM — `better-sqlite3` in WAL mode is the durable store, with an in-memory mirror
  (`Map`s) as the hot path. Every mutation updates memory and broadcasts immediately;
  the SQLite write is deferred one tick (`setImmediate`) so it never blocks a broadcast.
  On boot the in-memory state is rebuilt from SQLite, so a restart loses nothing.
- **Client**: Vite + Preact, vanilla CSS (no UI framework), installable PWA with a
  service-worker-cached app shell. ~10 KB gzipped JS.
- **Transport**: one WebSocket per device. Small delta messages for live updates
  (`team_update`, `request_new`, `request_resolved`, `decision`), a full snapshot on
  connect/reconnect. Reconnect uses exponential backoff (capped at 3s) with a 15s
  heartbeat; the client's countdown keeps ticking locally from timestamps while
  reconnecting, so a flaky connection never freezes the display.
- **Time model**: the server is the single source of truth and never ticks over the
  network. Each team stores `remaining_ms_at_last_stop`, `running_since` (or `null`),
  and `status`. `remaining_ms(now) = remaining_ms_at_last_stop - (now - running_since)`
  when running, else just `remaining_ms_at_last_stop` — and it can go negative
  (overtime). Clients compute the countdown locally and periodically sync a clock
  offset to the server (NTP-style, lowest-RTT sample wins), so the displayed time
  matches the server within ~100ms even on a wrong phone clock.
- **Status machine** (shared per team, not per device):
  `IN → (Go Out) → OUT_PENDING → accept → OUT → (Enter) → RETURN_PENDING → accept → IN`.
  Rejecting a Go Out returns to `IN` with nothing started. Rejecting an Enter returns to
  `OUT` with the clock **never paused** — it kept running the whole time the Enter was
  pending. This is intentional: teams absorb admin response latency, not the other way
  around.
- **Concurrency**: Node is single-threaded, so "first admin to have their `decide`
  message processed wins" is naturally atomic — the losing requests find nothing left
  in the pending-requests map and get a quiet "already handled by X" reply, nothing
  else happens.

### File layout

```
server/src/
  types.ts     shared types (Team, TeamRequest, Session, ...)
  time.ts      pure state-machine functions (unit tested)
  db.ts        SQLite schema + connection
  state.ts     in-memory Store, mirrors + persists to SQLite
  auth.ts      code generation/hashing, token generation, failed-login rate limiter
  ws.ts        the Hub: WebSocket message handling + broadcast
  http.ts      Fastify routes (login, admin actions, audit export) + WS upgrade wiring
  index.ts     bootstrap
  seed.ts      CLI: reads teams.csv, writes teams.csv with access codes, seeds the DB
client/src/
  lib/clock.ts       NTP-style clock offset estimator
  lib/wsclient.ts    WebSocket wrapper: reconnect/backoff, ping bursts, buffered events
  lib/api.ts         REST calls (login, reissue, audit CSV URL)
  lib/session.ts     localStorage session persistence
  lib/format.ts      duration/relative-time formatting
  screens/LoginScreen.tsx
  screens/TeamScreen.tsx   countdown, optimistic Go Out/Enter, pending banner
  screens/AdminScreen.tsx  live queue, team grid, overtime alerts, overrides, CSV export
  App.tsx, main.tsx, style.css
scripts/loadtest.ts   load/latency/race-condition test harness (see Verification below)
tests/time.test.ts    unit tests for the status machine and remaining-time math
```

## Mobile-first UI

Both roles are expected to run this from a phone, so the UI was built and verified at
375×812 (iPhone-class) width, not just scaled down from desktop:

- One field to log in as a team (`XXXX-XXXX`), auto-uppercased, with the right mobile
  keyboard hints (`autocapitalize`, `inputmode`, `enterkeyhint`) so the OS keyboard
  doesn't fight the input.
- The countdown and the Go Out / Enter button are the only things on screen — a single
  thumb-reachable circular button (sized responsively, `clamp()`-based so it never
  overflows a narrow screen), big enough to hit without looking.
- Every interactive element meets the ~44px minimum touch target (Apple HIG / Material
  guidance): admin's Accept/Reject are full-width stacked buttons, not a cramped side-by-
  side pair, specifically so a stressed admin can't fat-finger the wrong one.
- `touch-action: manipulation` + `-webkit-tap-highlight-color: transparent` everywhere,
  so taps register instantly with no 300ms delay, no double-tap-to-zoom, no gray flash.
- Safe-area insets (`env(safe-area-inset-*)`) so content clears the notch/home-indicator
  on iPhones, `100dvh`/`100svh` instead of `100vh` so mobile browser chrome resizing
  doesn't clip the layout.
- `viewport-fit=cover`, `user-scalable=no`, and standalone-mode meta tags so once added
  to the home screen it behaves like a native app, not a browser tab.
- Verified live in a 375×812 viewport end-to-end: login → Go Out → optimistic "waiting
  for admin" state → a second phone-width session (the admin) accepting it → the first
  screen flipping to a live-counting "Currently OUT" with the green Enter button.

## Setup

```bash
npm install            # installs server + client workspaces
npm run build           # builds server (tsc) and client (vite)
```

### Environment variables (server)

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP/WS port |
| `ADMIN_CODE` | `ADMIN-DEV` | Shared admin login code — **set this** |
| `HMAC_SECRET` | `dev-secret-change-me` | Secret used to hash team access codes — **set this**, and keep it stable across restarts/seeding or existing codes stop working |
| `TOTAL_OUT_MS` | `25200000` (7h) | Per-team out-time budget |
| `DB_PATH` | `./data/outtime.db` | SQLite file (put it on a persistent volume) |
| `CLIENT_DIST` | unset | If set, the server also serves the built client from this path (single-process deploy) |

### Seeding teams

```bash
# teams.csv: team_name,leader_email (header row optional)
HMAC_SECRET=<prod-secret> DB_PATH=./data/outtime.db npm run seed -- teams.csv teams_with_codes.csv
```

Writes `teams_with_codes.csv` (`team_name,leader_email,access_code`) — the only place the
plaintext codes ever exist. Distribute it to team leads and then delete it. The DB only
ever stores an HMAC-SHA256 hash of each code (keyed by `HMAC_SECRET`); codes are 8
characters from `23456789ABCDEFGHJKMNPQRSTUVWXYZ` (no `0/O/1/I/L`), shown as `XXXX-XXXX`,
generated with `crypto.randomInt`.

### Running

```bash
# dev (two processes, client proxies /api and /ws to :8080)
HMAC_SECRET=... ADMIN_CODE=... npm run dev:server
npm run dev:client

# production, single process serving the built client too
npm run build
HMAC_SECRET=... ADMIN_CODE=... CLIENT_DIST=./client/dist npm run start
```

### Deployment

Single small instance in the region closest to the venue (default recommendation:
`ap-south-1`, Mumbai). One container, one persistent volume mounted at `/app/data` for
the SQLite file:

```bash
docker build -t outtime .
docker run -p 8080:8080 \
  -e ADMIN_CODE=... -e HMAC_SECRET=... -e TOTAL_OUT_MS=25200000 \
  -v outtime-data:/app/data \
  outtime
```

### LAN fallback

If the venue internet drops, run the exact same container/command on a laptop on the
venue wifi (`npm run build && HMAC_SECRET=... ADMIN_CODE=... CLIENT_DIST=./client/dist npm start`,
bound to `0.0.0.0:8080`), point devices at `http://<laptop-ip>:8080`, and re-seed or copy
`data/outtime.db` over if you want to carry state across. Since the client re-syncs its
clock offset and resyncs full state on every reconnect, moving between the cloud instance
and the LAN laptop mid-event just looks like a reconnect to the team using it.

## Verification

### 1. Unit tests — state machine correctness

```bash
npx vitest run
```

17/17 passing, covering: Go Out accept starts the clock; Go Out reject starts nothing;
Enter pending does **not** stop the clock; Enter accept stops it and freezes remaining
(including going negative = overtime); Enter reject keeps the clock running; an exhausted
team (`remaining <= 0`) cannot Go Out but can still Enter; admin minute-adjustments and
force-in/force-out overrides.

### 2. Load test — fanout latency, 50 teams × 4 sockets + 20 admins, 200 cycles

```bash
npm run seed -- teams.csv teams_out.csv   # from server/, with HMAC_SECRET/DB_PATH set
npm run start                             # from server/
CODES=$(tail -n +2 teams_out.csv | cut -d, -f3 | tr '\n' ',' )
BASE_URL=http://localhost:8080 ADMIN_CODE=... TEAM_CODES="$CODES" \
  NUM_TEAMS=50 NUM_ADMINS=20 CYCLES=200 npx tsx scripts/loadtest.ts
```

**Measured (this machine, localhost):**

| Metric | p50 | p95 | p99 | Target | Result |
|---|---|---|---|---|---|
| Login | 0.3 ms | 0.8 ms | 4.8 ms | < 400 ms | ✅ |
| Go Out → visible on all 20 admin screens | 0.3 ms | 0.7 ms | 1.9 ms | < 300 ms | ✅ |
| Admin decide → team screen updated | 0.3 ms | 0.5 ms | 2.4 ms | < 300 ms | ✅ |

(Localhost numbers are obviously a floor, not a WAN estimate — but the server-side
budget the spec cares about, "server processing + fanout < 50ms," is the dominant cost
here and it's consistently under 2ms; real-world latency will mostly be each device's
own network RTT, which the server can't control.)

### 3. Race test — 20 admins accept the same request simultaneously

Included in the load test script. Verified two ways:
- Every admin socket sees exactly one `request_resolved` broadcast and the request
  vanishes from the pending list atomically (Node's single-threaded message processing
  makes "first one in wins" exact — there's no window for two admins to both succeed).
- Cross-checked against the audit log: across 200 full cycles (400 accepts) plus the
  20-way race, the audit log shows **exactly 401** `*_accept` entries — i.e. exactly one
  of the 20 racing admins actually won, independent of what each client observed over
  the wire.

### 4. Restart test

Killed the server mid-run while a team was `OUT` with its clock running, waited, restarted:
status, `remaining_ms_at_last_stop`, and `running_since` all came back exactly as they
were (SQLite WAL + rebuild-on-boot), and the countdown continued from the correct
elapsed wall-clock time rather than resetting.

### 5. Reconnect test

Abruptly terminated a team's WebSocket (no close handshake) mid-session and reconnected
~3s later: the new connection receives a fresh, consistent snapshot and no duplicate
requests were created (client-generated `clientReqId`s make every mutation idempotent on
retry).

### 6. Clock-skew test

Verified the NTP-style offset algorithm (lowest-RTT sample, symmetric-latency
assumption) analytically and in the live client: a 5-minute client clock skew converges
to <1ms of drift against true server time after a few ping round trips over loopback —
comfortably inside the 150ms target.

### 7. Bundle size / Lighthouse-equivalent

```
dist/assets/index-*.js    27.2 kB   gzip: 10.17 kB
dist/assets/index-*.css    5.8 kB   gzip:  1.84 kB
```

~12 KB gzipped total JS+CSS against a 60 KB target. Service worker precaches the full
app shell (139 KB uncompressed across all assets) for instant repeat loads. No heavy UI
library, system fonts only, single CSS file.

### 8. Security checks

- Codes are never stored in plaintext — verified in SQLite (`code_hash` column holds a
  64-char HMAC-SHA256 hex digest, not a code).
- Failed logins are rate-limited per IP (20/min) **without throttling legitimate
  traffic** — successful logins never count against the limiter (only a failed
  code/admin-code attempt does), which is both the spec's intent (protect against brute
  force, not against a crowded venue NAT) and was confirmed under the load test's 200+
  successful logins from one IP hitting zero 429s, while a 21st deliberately-wrong code
  in a row correctly got `429`.
- Admin endpoints reject team tokens and vice versa (401), confirmed directly against
  `/api/admin/audit` and `/api/admin/reissue`.
- Reissuing a team's code invalidates the old code (401 on next login attempt) **and**
  every existing session token for that team (the live WebSocket gets dropped with a
  401 on next connect attempt) — confirmed end-to-end.

## Known trade-offs / what I'd do with more time

- The in-memory `Store` holds every team/session/request in a `Map` — fine at this
  scale (dozens of teams, dozens of admins) but would need sharding or a real DB for
  much larger events.
- `ADMIN_CODE` is a single shared secret for all 15–20 admins; the audit log is what
  gives per-admin accountability (`actor` field on every decision), not per-admin auth.
- No HTTPS/WSS termination here — put this behind a reverse proxy (nginx/Caddy) or your
  cloud provider's load balancer for TLS in production; `wss://` for the LAN fallback
  is optional given the trust boundary (routed on the venue's own wifi).
