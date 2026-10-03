import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";
import type { Store } from "./state.js";
import { Hub } from "./ws.js";
import { generateCode, formatCode, hashCode, normalizeCodeInput, generateToken, RateLimiter } from "./auth.js";
import type { Session, Team } from "./types.js";
import { toPublicTeam } from "./types.js";

export interface AppConfig {
  adminCode: string;
  hmacSecret: string;
  totalOutMs: number;
  port: number;
  clientOrigin?: string;
  clientDist?: string;
}

export function buildApp(store: Store, config: AppConfig) {
  const app = Fastify({ logger: false });
  const hub = new Hub(store);

  // The frontend (Vercel) and this backend (Render) are different origins, so
  // CORS has to be explicit. No cookies are used anywhere (auth is a bearer
  // token / query param), so a permissive origin here doesn't expose
  // anything a stolen token wouldn't already -- but set CLIENT_ORIGIN in
  // production to pin it to your actual Vercel URL anyway.
  app.register(cors, { origin: config.clientOrigin ?? true });

  // Rate-limit only FAILED login attempts per IP (generous: 20/min), since many
  // attendees share one venue NAT IP and successful logins must never be throttled.
  const failedLoginLimiter = new RateLimiter(20, 60_000);
  setInterval(() => failedLoginLimiter.sweep(), 60_000).unref();

  function clientIp(req: any): string {
    return (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip;
  }

  // ---- Team login ----
  app.post("/api/login", async (req, reply) => {
    const ip = clientIp(req);
    if (failedLoginLimiter.isBlocked(ip)) {
      return reply.code(429).send({ error: "too many failed attempts, try again shortly" });
    }
    const body = req.body as { code?: string };
    if (!body?.code) return reply.code(400).send({ error: "code required" });
    const normalized = normalizeCodeInput(body.code);
    const codeHash = hashCode(normalized, config.hmacSecret);
    const teamId = store.teamsByCodeHash.get(codeHash);
    if (!teamId) {
      failedLoginLimiter.recordFailure(ip);
      return reply.code(401).send({ error: "invalid code" });
    }
    const team = store.teams.get(teamId)!;

    const token = generateToken();
    const session: Session = { token, role: "team", teamId: team.id, adminName: null, createdAt: Date.now() };
    store.insertSession(session);

    return { token, teamId: team.id, teamName: team.name };
  });

  // ---- Admin login ----
  app.post("/api/admin/login", async (req, reply) => {
    const ip = clientIp(req);
    if (failedLoginLimiter.isBlocked(ip)) {
      return reply.code(429).send({ error: "too many failed attempts, try again shortly" });
    }
    const body = req.body as { code?: string; name?: string };
    if (!body?.code || !body?.name) return reply.code(400).send({ error: "code and name required" });
    if (body.code !== config.adminCode) {
      failedLoginLimiter.recordFailure(ip);
      return reply.code(401).send({ error: "invalid code" });
    }

    const token = generateToken();
    const session: Session = {
      token,
      role: "admin",
      teamId: null,
      adminName: body.name.trim().slice(0, 60),
      createdAt: Date.now(),
    };
    store.insertSession(session);
    return { token, name: session.adminName };
  });

  // ---- Admin: reissue a team code (plaintext returned once) ----
  app.post("/api/admin/reissue", async (req, reply) => {
    const session = authAdmin(req, store);
    if (!session) return reply.code(401).send({ error: "unauthorized" });
    const body = req.body as { teamId?: string };
    if (!body?.teamId) return reply.code(400).send({ error: "teamId required" });
    const team = store.teams.get(body.teamId);
    if (!team) return reply.code(404).send({ error: "team not found" });

    const newRaw = generateCode();
    const newHash = hashCode(newRaw, config.hmacSecret);
    store.reissueCode(team.id, newHash);
    store.addAudit({
      ts: Date.now(),
      type: "reissue_code",
      teamId: team.id,
      detail: JSON.stringify({}),
      actor: session.adminName,
    });
    return { code: formatCode(newRaw) };
  });

  // ---- Admin: audit log CSV export ----
  app.get("/api/admin/audit.csv", async (req, reply) => {
    const session = authAdmin(req, store);
    if (!session) return reply.code(401).send({ error: "unauthorized" });
    const rows = await store.getAllAuditLog();
    const header = "id,ts,iso_time,type,team_id,team_name,actor,detail\n";
    const lines = rows.map((r) => {
      const team = r.teamId ? store.teams.get(r.teamId) : undefined;
      const iso = new Date(r.ts).toISOString();
      const detail = (r.detail ?? "").replace(/"/g, '""');
      return `${r.id},${r.ts},${iso},${r.type},${r.teamId ?? ""},"${team?.name ?? ""}","${r.actor ?? ""}","${detail}"`;
    });
    reply.header("Content-Type", "text/csv");
    reply.header("Content-Disposition", "attachment; filename=audit_log.csv");
    return header + lines.join("\n") + "\n";
  });

  app.get("/api/admin/audit", async (req, reply) => {
    const session = authAdmin(req, store);
    if (!session) return reply.code(401).send({ error: "unauthorized" });
    return { entries: await store.getAuditLog(2000) };
  });

  app.get("/api/health", async () => ({ ok: true, now: Date.now() }));

  if (config.clientDist) {
    app.register(fastifyStatic, {
      root: path.resolve(config.clientDist),
    });
  }

  return { app, hub };
}

function authTeam(req: any, store: Store): Session | null {
  const token = extractToken(req);
  if (!token) return null;
  const session = store.sessions.get(token);
  if (!session || session.role !== "team") return null;
  return session;
}

function authAdmin(req: any, store: Store): Session | null {
  const token = extractToken(req);
  if (!token) return null;
  const session = store.sessions.get(token);
  if (!session || session.role !== "admin") return null;
  return session;
}

function extractToken(req: any): string | null {
  const auth = req.headers?.authorization as string | undefined;
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  const url = new URL(req.url, "http://x");
  return url.searchParams.get("token");
}

export function attachWebSocketServer(app: ReturnType<typeof buildApp>["app"], hub: Hub, store: Store) {
  const wss = new WebSocketServer({ noServer: true });

  app.server.on("upgrade", (request, socket, head) => {
    if (!request.url?.startsWith("/ws")) return;
    const url = new URL(request.url, "http://x");
    const token = url.searchParams.get("token");
    const session = token ? store.sessions.get(token) : undefined;
    if (!session) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws: any) => {
      // handleUpgrade's callback does NOT emit "connection" on the WebSocketServer (that's only
      // done automatically when noServer is false), so heartbeat/isAlive setup must happen here
      // directly -- a wss.on("connection", ...) listener would simply never fire and every socket
      // would silently look "dead" and get terminated by the next heartbeat sweep.
      ws.isAlive = true;
      ws.on("pong", () => {
        ws.isAlive = true;
      });
      hub.register(ws, session);
    });
  });

  // heartbeat: ping every 15s, terminate dead sockets
  const interval = setInterval(() => {
    wss.clients.forEach((ws: any) => {
      if (ws.isAlive === false) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 15000);
  wss.on("close", () => clearInterval(interval));

  return wss;
}
