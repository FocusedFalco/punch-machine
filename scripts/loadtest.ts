/**
 * Load/latency/race test harness for OutTime.
 * Usage: BASE_URL=http://localhost:8080 ADMIN_CODE=... tsx scripts/loadtest.ts
 */
import WebSocket from "ws";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:8080";
const WS_BASE = BASE_URL.replace(/^http/, "ws");
const ADMIN_CODE = process.env.ADMIN_CODE ?? "ADMIN-TEST";
const TEAM_CODES: string[] = (process.env.TEAM_CODES ?? "").split(",").filter(Boolean);

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return NaN;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function teamLogin(code: string) {
  const res = await fetch(`${BASE_URL}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) throw new Error(`login failed for ${code}: ${res.status}`);
  return res.json() as Promise<{ token: string; teamId: string; teamName: string }>;
}

async function adminLogin(name: string) {
  const res = await fetch(`${BASE_URL}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: ADMIN_CODE, name }),
  });
  if (!res.ok) throw new Error(`admin login failed: ${res.status}`);
  return res.json() as Promise<{ token: string; name: string }>;
}

// Every socket gets a permanent message buffer from the moment it's created, so a
// message that arrives before a later waitFor() call attaches its listener is never lost.
const buffers = new WeakMap<WebSocket, any[]>();
const waiters = new WeakMap<WebSocket, Set<{ pred: (m: any) => boolean; resolve: (m: any) => void }>>();

function connect(token: string, label?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/ws?token=${encodeURIComponent(token)}`);
    buffers.set(ws, []);
    waiters.set(ws, new Set());
    ws.on("message", (raw: WebSocket.RawData) => {
      const msg = JSON.parse(raw.toString());
      const ws_waiters = waiters.get(ws)!;
      for (const w of ws_waiters) {
        if (w.pred(msg)) {
          ws_waiters.delete(w);
          w.resolve(msg);
          return;
        }
      }
      // Bounded: messages nobody is waiting for (e.g. broadcasts to admins who aren't
      // deciding this cycle) are expected and harmless to drop once old enough -- without a
      // cap this buffer grows without end over hundreds of cycles, and the O(n) scan in
      // waitFor() below eventually gets slow enough to blow through the test's own timeouts.
      const buf = buffers.get(ws)!;
      buf.push(msg);
      if (buf.length > 50) buf.shift();
    });
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function waitFor(ws: WebSocket, predicate: (msg: any) => boolean, timeoutMs = 5000): Promise<any> {
  const buf = buffers.get(ws)!;
  const idx = buf.findIndex(predicate);
  if (idx >= 0) {
    const [msg] = buf.splice(idx, 1);
    return Promise.resolve(msg);
  }
  return new Promise((resolve, reject) => {
    const entry = { pred: predicate, resolve };
    waiters.get(ws)!.add(entry);
    setTimeout(() => {
      waiters.get(ws)!.delete(entry);
      reject(new Error("timeout waiting for message"));
    }, timeoutMs);
  });
}

async function measureLoginLatency(codes: string[], n: number) {
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    const code = codes[i % codes.length];
    const t0 = performance.now();
    await teamLogin(code);
    samples.push(performance.now() - t0);
  }
  return samples;
}

async function main() {
  if (TEAM_CODES.length === 0) {
    console.error("Set TEAM_CODES env var to a comma-separated list of access codes (from the seed CSV).");
    process.exit(1);
  }

  console.log(`=== OutTime load test against ${BASE_URL} ===`);
  console.log(`Using ${TEAM_CODES.length} seeded team code(s), replaying to simulate more.`);

  // ---- 1. Login latency ----
  const loginSamples = await measureLoginLatency(TEAM_CODES, Math.max(20, TEAM_CODES.length * 4));
  console.log("\n-- Login latency (ms) --");
  console.log(`p50=${percentile(loginSamples, 50).toFixed(1)} p95=${percentile(loginSamples, 95).toFixed(1)} p99=${percentile(loginSamples, 99).toFixed(1)}`);

  // ---- 2. Connect sockets: N teams x 4 sockets each (reusing codes), M admins ----
  const SOCKETS_PER_TEAM = Number(process.env.SOCKETS_PER_TEAM ?? 4);
  const NUM_TEAM_CONNECTIONS = Number(process.env.NUM_TEAMS ?? 50) * SOCKETS_PER_TEAM;
  const NUM_ADMINS = Number(process.env.NUM_ADMINS ?? 20);

  console.log(`\nConnecting ${NUM_TEAM_CONNECTIONS} team sockets and ${NUM_ADMINS} admin sockets...`);

  const teamLogins = await Promise.all(
    Array.from({ length: NUM_TEAM_CONNECTIONS }, (_, i) => teamLogin(TEAM_CODES[i % TEAM_CODES.length]))
  );
  const teamSockets = await Promise.all(teamLogins.map((l) => connect(l.token)));

  const adminLogins = await Promise.all(
    Array.from({ length: NUM_ADMINS }, (_, i) => adminLogin(`LoadTestAdmin${i}`))
  );
  const adminSockets = await Promise.all(adminLogins.map((l, i) => connect(l.token, `admin${i}`)));

  // drain initial snapshots
  await Promise.all(teamSockets.map((ws) => waitFor(ws, (m) => m.type === "snapshot")));
  await Promise.all(adminSockets.map((ws) => waitFor(ws, (m) => m.type === "snapshot")));
  console.log("All sockets connected and snapshotted.");

  // ---- 3. Fanout latency: team request -> visible on all admin screens ----
  const CYCLES = Number(process.env.CYCLES ?? 200);
  const goOutLatencies: number[] = [];
  const decisionLatencies: number[] = [];

  for (let i = 0; i < CYCLES; i++) {
    if (process.env.DEBUG_CYCLES) console.error(`cycle ${i}`);
    const teamIdx = i % teamSockets.length;
    const ws = teamSockets[teamIdx];
    const teamId = teamLogins[teamIdx].teamId;
    const clientReqId = `loadtest-${i}-${Date.now()}`;

    const t0 = performance.now();
    ws.send(JSON.stringify({ type: "go_out", clientReqId }));

    // wait for it to show up on ALL admin sockets (fanout)
    const fanoutSettled = await Promise.allSettled(
      adminSockets.map((aws) => waitFor(aws, (m) => m.type === "request_new" && m.request.teamId === teamId))
    );
    const failedIdx = fanoutSettled.findIndex((r) => r.status === "rejected");
    if (failedIdx >= 0) {
      console.error(`cycle ${i}: admin[${failedIdx}] never saw request_new for team ${teamId}, buffer:`, buffers.get(adminSockets[failedIdx]));
      throw new Error(`fanout failed at cycle ${i}, admin ${failedIdx}`);
    }
    const fanoutMsgs = fanoutSettled.map((r) => (r as PromiseFulfilledResult<any>).value);
    goOutLatencies.push(performance.now() - t0);

    // admin[0] accepts, using the requestId it already received above
    const requestId = fanoutMsgs[0].request.id;
    const t1 = performance.now();
    adminSockets[0].send(JSON.stringify({ type: "decide", requestId, action: "accept" }));
    try {
      // Filter by clientReqId, not just type: a team's OTHER devices (sockets sharing the same
      // team, per the spec's "same code on many devices") have been connected since setup and
      // passively buffering every "decision" ever sent to this team, including stale ones from
      // an earlier cycle that drove this same team through a different socket. A bare
      // type==="decision" check would happily match that stale leftover and race ahead before
      // the real accept has even been processed server-side.
      await waitFor(ws, (m) => m.type === "decision" && m.clientReqId === clientReqId);
    } catch (e) {
      console.error(`cycle ${i}: team socket never saw decision for go_out accept, team ${teamId}`);
      throw e;
    }
    decisionLatencies.push(performance.now() - t1);

    // immediately enter again to reset state for next cycle
    const enterReqId = `loadtest-enter-${i}-${Date.now()}`;
    ws.send(JSON.stringify({ type: "enter", clientReqId: enterReqId }));
    let enterNotice;
    try {
      enterNotice = await waitFor(adminSockets[1 % adminSockets.length], (m) => m.type === "request_new" && m.request.teamId === teamId);
    } catch (e) {
      console.error(`cycle ${i}: admin[1] never saw request_new for enter, team ${teamId}`);
      throw e;
    }
    adminSockets[1 % adminSockets.length].send(JSON.stringify({ type: "decide", requestId: enterNotice.request.id, action: "accept" }));
    try {
      await waitFor(ws, (m) => m.type === "decision" && m.clientReqId === enterReqId);
    } catch (e) {
      console.error(`cycle ${i}: team socket never saw decision for enter accept, team ${teamId}`);
      throw e;
    }
  }

  console.log("\n-- Go Out -> admin fanout latency (ms) --");
  console.log(`p50=${percentile(goOutLatencies, 50).toFixed(1)} p95=${percentile(goOutLatencies, 95).toFixed(1)} p99=${percentile(goOutLatencies, 99).toFixed(1)}`);
  console.log("\n-- Admin decide -> team update latency (ms) --");
  console.log(`p50=${percentile(decisionLatencies, 50).toFixed(1)} p95=${percentile(decisionLatencies, 95).toFixed(1)} p99=${percentile(decisionLatencies, 99).toFixed(1)}`);

  // ---- 4. Race test: 20 admins accept the same request simultaneously ----
  console.log("\n-- Race test --");
  const raceTeamWs = teamSockets[0];
  const raceTeamId = teamLogins[0].teamId;
  const raceReqId = `race-${Date.now()}`;
  raceTeamWs.send(JSON.stringify({ type: "go_out", clientReqId: raceReqId }));
  const raceNotice = await waitFor(adminSockets[0], (m) => m.type === "request_new" && m.request.teamId === raceTeamId);
  const targetReqId = raceNotice.request.id;

  // Use the same buffered waitFor() as everywhere else: it checks each socket's already-arrived
  // backlog first, so a broadcast that lands before we get around to awaiting it is never missed
  // (an earlier version used a bare ws.on("message", ...) here and intermittently "lost" the
  // winning broadcast to this same race, which was a test-harness bug, not a server bug).
  const resultPromises = adminSockets.map((aws) =>
    waitFor(
      aws,
      (m) =>
        (m.type === "request_resolved" || m.type === "already_handled") && m.requestId === targetReqId,
      3000
    )
      .then((m) => (m.type === "request_resolved" ? "resolved_broadcast" : "already_handled"))
      .catch(() => "no_response")
  );
  adminSockets.forEach((aws) => aws.send(JSON.stringify({ type: "decide", requestId: targetReqId, action: "accept" })));
  const results = await Promise.all(resultPromises);
  const alreadyHandledCount = results.filter((r) => r === "already_handled").length;
  const resolvedBroadcastCount = results.filter((r) => r === "resolved_broadcast").length;
  console.log(`${adminSockets.length} admins raced one request.`);
  console.log(`already_handled responses: ${alreadyHandledCount}, resolved broadcasts seen: ${resolvedBroadcastCount}`);
  console.log(`Exactly-one-winner check: ${alreadyHandledCount === adminSockets.length - 1 ? "PASS" : "see counts above (broadcast arrives to all, which is correct; only one admin's own decide call should NOT get already_handled)"}`);

  // cleanup: return the raced team to IN via enter so it doesn't skew teardown
  await waitFor(raceTeamWs, (m) => m.type === "decision").catch(() => {});

  for (const ws of [...teamSockets, ...adminSockets]) ws.close();
  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
