# OutTime

A punch-in/punch-out tracker for hackathons: every team gets a fixed budget of "out time"
(default 7 hours), shared across all of that team's devices, and admins approve/reject
every Go Out / Enter request in real time. Built mobile-first — teams and admins alike are
expected to use this from a phone during the event.

## Architecture

Three services, each doing the one thing it's good at:

- **Backend (Render)** — Node.js + TypeScript, Fastify + `ws`, one persistent long-running
  process. This is deliberately *not* serverless: Render keeps the process alive between
  requests, so it can hold open WebSocket connections and push updates the instant they
  happen, instead of polling. All live state (teams, pending requests, sessions) lives in
  plain `Map`s in memory — that's the hot path. Every mutation updates memory and
  broadcasts **immediately**; the Postgres write is fired off after and never awaited on
  that path, so a database round trip never sits between a tap and the update reaching
  every screen. On boot, the in-memory state is rebuilt from Postgres, so a restart loses
  nothing.
- **Database (Supabase)** — plain managed Postgres, nothing Supabase-specific is used
  (no Realtime, no RLS, no client-side access). The backend connects with `pg` over
  Supabase's **session pooler** (port 5432) — not the transaction pooler (6543), which is
  meant for serverless fan-out, not one persistent connection pool.
- **Frontend (Vercel)** — a static Vite + Preact build. No server-side logic runs here;
  it just talks to the backend's REST endpoints and WebSocket over `VITE_API_BASE`, from
  wherever Vercel happens to serve it from.
- **Transport**: one WebSocket per device, talking cross-origin to the Render backend.
  Small delta messages for live updates (`team_update`, `request_new`, `request_resolved`,
  `decision`), a full snapshot on connect/reconnect. Reconnect uses exponential backoff
  (capped at 3s) with a 15s heartbeat; the client's countdown keeps ticking locally from
  timestamps while reconnecting, so a flaky connection never freezes the display.
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
  message processed wins" is naturally atomic — nothing awaits in between the check and
  the claim, so there's no window for two admins to both succeed. The loser finds the
  request already resolved and gets a quiet "already handled by X" reply, nothing else
  happens. (See `resolveRequest` in `state.ts`.)

### Why this split, and not Vercel-only or one big self-hosted box

Vercel doesn't run persistent processes — functions spin down between requests and the
filesystem is ephemeral, so it can't hold a WebSocket open or write to a local SQLite
file. That rules out hosting the backend there. Render does run persistent processes,
which is what makes the in-memory-first, broadcast-before-persist design (and its
sub-millisecond latencies) possible at all — the alternative, forcing every mutation
through a serverless function with its own atomic-SQL-function dance, works but adds
real latency and complexity for no benefit here. Supabase is just a managed Postgres
instance in this picture; its Realtime/RLS features aren't used because the backend is
the only thing that ever touches the database directly.

### File layout

```
server/src/
  types.ts     shared types (Team, TeamRequest, Session, ...)
  time.ts      pure state-machine functions (unit tested)
  db.ts        Postgres schema + connection pool (pg)
  state.ts     in-memory Store, mirrors + persists to Postgres (fire-and-forget)
  auth.ts      code generation/hashing, token generation, failed-login rate limiter
  ws.ts        the Hub: WebSocket message handling + broadcast
  http.ts      Fastify routes (login, admin actions, audit export) + WS upgrade wiring
  index.ts     bootstrap
  seed.ts      CLI: reads teams.csv, writes teams.csv with access codes, seeds Postgres
client/src/
  lib/clock.ts       NTP-style clock offset estimator
  lib/wsclient.ts    WebSocket wrapper: reconnect/backoff, ping bursts, buffered events
  lib/api.ts         REST calls (login, reissue, audit CSV URL) against VITE_API_BASE
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

### 1. Database — Supabase

Create a free project at [supabase.com](https://supabase.com). No manual schema setup
needed — the backend creates its own tables on boot (`CREATE TABLE IF NOT EXISTS`, see
`server/src/db.ts`). You just need the connection string:

Project → **Connect** button (top of dashboard) → **Session pooler** tab → copy the
string. It looks like:

```
postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
```

Use the **session pooler**, not the direct connection (`db.<ref>.supabase.co`, which is
IPv6-only on new projects and won't resolve from an IPv4-only network) and not the
transaction pooler on port 6543 (meant for serverless, not one persistent pool).

If your password has special characters, URL-encode them in the connection string
(`#` → `%23`, `^` → `%5E`, `/` → `%2F`, etc.) or the URL won't parse correctly.

### 2. Backend — Render

Either point Render at the included `render.yaml` (Blueprint deploy), or set up a Web
Service manually with:
- **Root directory**: `server`
- **Build command**: `npm install && npm run build`
- **Start command**: `npm run start`
- **Health check path**: `/api/health`

Environment variables (see `.env.example` for the full annotated list):

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP/WS port (Render sets this for you) |
| `ADMIN_CODE` | `ADMIN-DEV` | Shared admin login code — **set this** |
| `HMAC_SECRET` | `dev-secret-change-me` | Secret used to hash team access codes — **set this**, and keep it stable across restarts/seeding or existing codes stop working |
| `TOTAL_OUT_MS` | `25200000` (7h) | Per-team out-time budget |
| `DATABASE_URL` | — (required) | Your Supabase session-pooler connection string |
| `CLIENT_ORIGIN` | unset (allows any origin) | Pin CORS to your Vercel URL in production |

### 3. Frontend — Vercel

Create a Vercel project with **Root Directory** set to `client/` (Vercel auto-detects
the Vite app from there, no custom build config needed). Set one env var:

| Var | Purpose |
|---|---|
| `VITE_API_BASE` | Your Render backend's URL, e.g. `https://outtime-backend.onrender.com` |

### Seeding teams

```bash
# teams.csv: team_name,leader_email (header row optional)
cd server
HMAC_SECRET=<prod-secret> DATABASE_URL=<your-session-pooler-url> \
  npm run seed -- teams.csv teams_with_codes.csv
```

Writes `teams_with_codes.csv` (`team_name,leader_email,access_code`) — the only place the
plaintext codes ever exist. Distribute it to team leads and then delete it. The database
only ever stores an HMAC-SHA256 hash of each code (keyed by `HMAC_SECRET`); codes are 8
characters from `23456789ABCDEFGHJKMNPQRSTUVWXYZ` (no `0/O/1/I/L`), shown as `XXXX-XXXX`,
generated with `crypto.randomInt`. **Restart the backend after seeding** (or seed before
first boot) so the new teams are picked up into memory.

### Running locally

```bash
# terminal 1 — backend
cd server
DATABASE_URL=... HMAC_SECRET=... ADMIN_CODE=... npm run dev

# terminal 2 — frontend
cd client
echo "VITE_API_BASE=http://localhost:8080" > .env.local
npm run dev
```

### LAN fallback

If the venue internet drops, run the backend on a laptop on the venue wifi instead
(`npm run build && DATABASE_URL=... HMAC_SECRET=... ADMIN_CODE=... npm run start` from
`server/`, bound to `0.0.0.0:8080` by default) and point `VITE_API_BASE` at
`http://<laptop-ip>:8080` — rebuild and reload the client, or keep a pre-built fallback
copy ready. Supabase itself has no offline fallback, so for a true no-internet scenario
you'd also need Postgres running locally on that laptop; for a brief outage, Render and
Supabase both tolerate a dropped connection and the client reconnects/resyncs
automatically once connectivity returns, which is the more common case.

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
cd server
HMAC_SECRET=... DATABASE_URL=... npm run seed -- teams.csv teams_out.csv
HMAC_SECRET=... ADMIN_CODE=... DATABASE_URL=... npm run start
CODES=$(tail -n +2 teams_out.csv | cut -d, -f3 | tr '\n' ',' )
BASE_URL=http://localhost:8080 ADMIN_CODE=... TEAM_CODES="$CODES" \
  NUM_TEAMS=50 NUM_ADMINS=20 CYCLES=200 npx tsx scripts/loadtest.ts
```

**Measured (localhost backend, SQLite-era run — see note below):**

| Metric | p50 | p95 | p99 | Target | Result |
|---|---|---|---|---|---|
| Login | 0.3 ms | 0.8 ms | 4.8 ms | < 400 ms | ✅ |
| Go Out → visible on all 20 admin screens | 0.3 ms | 0.7 ms | 1.9 ms | < 300 ms | ✅ |
| Admin decide → team screen updated | 0.3 ms | 0.5 ms | 2.4 ms | < 300 ms | ✅ |

These numbers predate the Postgres migration, but the architecture change doesn't touch
the hot path: persistence was already fire-and-forget (`setImmediate` for SQLite, a bare
`.catch()` for Postgres now), so swapping the storage engine changes *how soon a write is
durable on disk*, not *how long a request takes* — broadcast still happens before any
database I/O starts. This was confirmed directly: see "Live verification against
Supabase" below, where the same request/accept/enter cycle against the real hosted
database showed no observable change in responsiveness.

### 3. Race test — N admins accept the same request simultaneously

Included in the load test script, and re-verified directly against Supabase with 10
concurrent admins. Verified two ways:
- Every admin socket sees exactly one `request_resolved` broadcast and the request
  vanishes from the pending list atomically (Node's single-threaded message processing
  makes "first one in wins" exact — there's no window for two admins to both succeed).
- Cross-checked against the audit log: across 200 full cycles (400 accepts) plus a
  20-way race in the local SQLite-era run, the audit log showed **exactly 401**
  `*_accept` entries. Re-run live against Supabase Postgres with 10 racing admins: the
  audit log shows **exactly one** `decide_go_out_accept` row for the raced request,
  regardless of what each of the 10 clients individually observed over the wire.

### 4. Restart test

Killed the server mid-run while a team was `OUT` with its clock running, waited,
restarted: status, `remaining_ms_at_last_stop`, and `running_since` all came back
exactly as they were. Confirmed against **real Supabase Postgres**: after restart, the
team's `running_since` round-tripped through a Postgres `BIGINT` column and back into a
JS number byte-for-byte, and the computed elapsed-time-while-OUT matched real wall-clock
time across the restart to the millisecond.

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
dist/assets/index-*.js    27.2 kB   gzip: 10.16 kB
dist/assets/index-*.css    5.8 kB   gzip:  1.84 kB
```

~12 KB gzipped total JS+CSS against a 60 KB target — unchanged by the architecture
switch, since the client still talks a plain WebSocket protocol to the backend rather
than carrying any Supabase client library. Service worker precaches the full app shell
for instant repeat loads. No heavy UI library, system fonts only, single CSS file.

### 8. Security checks

- Codes are never stored in plaintext — verified directly in the live Supabase database
  (`code_hash` column holds a 64-char HMAC-SHA256 hex digest, not a code).
- Failed logins are rate-limited per IP (20/min) **without throttling legitimate
  traffic** — successful logins never count against the limiter (only a failed
  code/admin-code attempt does). Confirmed against the live Render-pattern server: 20
  consecutive wrong codes each return `401`, the 21st returns `429`.
- Admin endpoints reject team tokens and vice versa (401), confirmed directly against
  `/api/admin/audit` and `/api/admin/reissue`.
- Reissuing a team's code invalidates the old code (401 on next login attempt) **and**
  every existing session token for that team (the live WebSocket gets dropped with a
  401 on next connect attempt) — confirmed end-to-end.

### Live verification against Supabase

All of the above (full Go-Out/accept/Enter/accept cycle, 10-way admin race, restart
recovery, plaintext check, rate limiting) was additionally run against a real hosted
Supabase Postgres instance (`ap-northeast-1`, via the session pooler) rather than only a
local database, specifically to catch issues a local-only test can't: connection string
quirks (IPv6-only direct hostnames, pooler region mismatches), SSL handshake behavior,
and `pg`'s behavior of returning `BIGINT` columns as strings rather than numbers (handled
explicitly in `state.ts`'s rebuild-from-database path). Everything passed identically to
the local run.

## Known trade-offs / what I'd do with more time

- The in-memory `Store` holds every team/session/request in a `Map` for the lifetime of
  the process — fine at this scale (dozens of teams, a few thousand requests over a
  multi-day event) but would need eviction or a real query layer for much larger events.
- `ADMIN_CODE` is a single shared secret for all 15–20 admins; the audit log is what
  gives per-admin accountability (`actor` field on every decision), not per-admin auth.
- CORS between Vercel and Render is permissive by default (`CLIENT_ORIGIN` unset); set it
  in production. No cookies are used anywhere (auth is a bearer token / query param), so
  this doesn't expose anything a stolen token wouldn't already.
- The `ssl: { rejectUnauthorized: false }` on the Postgres connection (see `db.ts`)
  encrypts the connection but doesn't verify Supabase's certificate chain — standard
  practice for quickly wiring up a pooler connection, but pin it properly with
  Supabase's CA certificate if this were going into longer-term production use.
- Single Render instance = single point of failure for the backend; fine for a one-venue,
  one-day event, not for anything that needs multi-region failover.
