import type { WebSocket, WebSocketServer } from "ws";
import crypto from "node:crypto";
import type { Store } from "./state.js";
import {
  applyEnterAccept,
  applyEnterReject,
  applyEnterRequest,
  applyGoOutAccept,
  applyGoOutReject,
  applyGoOutRequest,
  canEnter,
  canGoOut,
  remainingMs,
  StateError,
} from "./time.js";
import { toPublicTeam } from "./types.js";
import type { Session, Team, TeamRequest } from "./types.js";

interface Conn {
  ws: WebSocket;
  session: Session;
}

export class Hub {
  private teamConns = new Map<string, Set<Conn>>(); // teamId -> conns
  private adminConns = new Set<Conn>();

  constructor(private store: Store) {}

  private allConnsForTeam(teamId: string): Conn[] {
    return Array.from(this.teamConns.get(teamId) ?? []);
  }

  register(ws: WebSocket, session: Session) {
    const conn: Conn = { ws, session };
    if (session.role === "admin") {
      this.adminConns.add(conn);
    } else if (session.teamId) {
      if (!this.teamConns.has(session.teamId)) this.teamConns.set(session.teamId, new Set());
      this.teamConns.get(session.teamId)!.add(conn);
    }

    ws.on("close", () => {
      this.adminConns.delete(conn);
      const set = session.teamId ? this.teamConns.get(session.teamId) : undefined;
      set?.delete(conn);
    });

    this.sendSnapshot(conn);

    ws.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      try {
        this.handleMessage(conn, msg);
      } catch (err) {
        this.send(conn, { type: "error", message: err instanceof Error ? err.message : "error" });
      }
    });
  }

  private send(conn: Conn, msg: unknown) {
    if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(JSON.stringify(msg));
  }

  private broadcastAdmins(msg: unknown) {
    for (const c of this.adminConns) this.send(c, msg);
  }

  private broadcastTeam(teamId: string, msg: unknown) {
    for (const c of this.allConnsForTeam(teamId)) this.send(c, msg);
  }

  private teamUpdateMsg(team: Team) {
    return { type: "team_update", team: toPublicTeam(team, this.store.getTotalOutMs()) };
  }

  private broadcastTeamUpdate(team: Team) {
    const msg = this.teamUpdateMsg(team);
    this.broadcastTeam(team.id, msg);
    this.broadcastAdmins(msg);
  }

  private sendSnapshot(conn: Conn) {
    const now = Date.now();
    if (conn.session.role === "team" && conn.session.teamId) {
      const team = this.store.teams.get(conn.session.teamId);
      if (!team) return;
      const pendingReq = this.store.findPendingForTeam(team.id);
      this.send(conn, {
        type: "snapshot",
        now,
        totalOutMs: this.store.getTotalOutMs(),
        team: toPublicTeam(team, this.store.getTotalOutMs()),
        pendingRequest: pendingReq ?? null,
      });
    } else if (conn.session.role === "admin") {
      const teams = Array.from(this.store.teams.values()).map((t) => toPublicTeam(t, this.store.getTotalOutMs()));
      const requests = this.store.getPendingRequests().map((r) => this.decorateRequest(r));
      this.send(conn, { type: "snapshot", now, totalOutMs: this.store.getTotalOutMs(), teams, requests });
    }
  }

  private decorateRequest(r: TeamRequest) {
    const team = this.store.teams.get(r.teamId);
    return { ...r, teamName: team?.name ?? "?" };
  }

  private handleMessage(conn: Conn, msg: any) {
    if (msg.type === "ping") {
      this.send(conn, { type: "pong", t: msg.t, s: Date.now() });
      return;
    }

    if (conn.session.role === "team") {
      this.handleTeamMessage(conn, msg);
    } else if (conn.session.role === "admin") {
      this.handleAdminMessage(conn, msg);
    }
  }

  private handleTeamMessage(conn: Conn, msg: any) {
    const teamId = conn.session.teamId!;
    const team = this.store.teams.get(teamId);
    if (!team) return;

    if (msg.type === "go_out" || msg.type === "enter") {
      const clientReqId: string = msg.clientReqId;
      if (!clientReqId) return this.send(conn, { type: "error", message: "clientReqId required" });

      const existing = this.store.findByClientReqId(teamId, clientReqId);
      if (existing) {
        // Idempotent retry: just re-send current state, don't create a duplicate.
        this.send(conn, { type: "request_ack", clientReqId, requestId: existing.id, status: existing.status });
        return;
      }

      const now = Date.now();
      try {
        if (msg.type === "go_out") {
          if (!canGoOut(team, now)) throw new StateError("cannot go out now");
          const updated = applyGoOutRequest(team);
          this.commitTeam(updated);
        } else {
          if (!canEnter(team)) throw new StateError("cannot enter now");
          const updated = applyEnterRequest(team);
          this.commitTeam(updated);
        }
      } catch (err) {
        this.send(conn, { type: "error", message: err instanceof Error ? err.message : "error" });
        return;
      }

      const req: TeamRequest = {
        id: crypto.randomUUID(),
        teamId,
        type: msg.type,
        status: "pending",
        createdAt: now,
        resolvedAt: null,
        resolvedBy: null,
        clientReqId,
      };
      this.store.insertRequest(req);
      this.send(conn, { type: "request_ack", clientReqId, requestId: req.id, status: "pending" });
      this.broadcastAdmins({ type: "request_new", request: this.decorateRequest(req) });
      this.store.addAudit({
        ts: now,
        type: `request_${msg.type}`,
        teamId,
        detail: JSON.stringify({ requestId: req.id }),
        actor: `team:${team.name}`,
      });
    }
  }

  private commitTeam(team: Team) {
    team.updatedAt = Date.now();
    this.store.teams.set(team.id, team);
    this.store.persistTeam(team);
    this.broadcastTeamUpdate(team);
  }

  private handleAdminMessage(conn: Conn, msg: any) {
    const actor = conn.session.adminName ?? "admin";

    if (msg.type === "decide") {
      const { requestId, action } = msg as { requestId: string; action: "accept" | "reject" };
      const req = this.store.requests.get(requestId);
      if (!req || req.status !== "pending") {
        // Already handled by someone else, or unknown.
        this.send(conn, { type: "already_handled", requestId, by: "another admin" });
        return;
      }
      const team = this.store.teams.get(req.teamId);
      if (!team) return;

      const now = Date.now();
      let updatedTeam: Team;
      try {
        if (req.type === "go_out") {
          updatedTeam = action === "accept" ? applyGoOutAccept(team, now) : applyGoOutReject(team);
        } else {
          updatedTeam = action === "accept" ? applyEnterAccept(team, now) : applyEnterReject(team);
        }
      } catch (err) {
        this.send(conn, { type: "error", message: err instanceof Error ? err.message : "error" });
        return;
      }

      // Atomic win: resolveRequest only succeeds if still 'pending' right now -- the
      // single decision point, safe because nothing above this line awaited anything.
      const claimed = this.store.resolveRequest(requestId, action === "accept" ? "accepted" : "rejected", actor, now);
      if (!claimed) {
        this.send(conn, { type: "already_handled", requestId, by: "another admin" });
        return;
      }
      this.commitTeam(updatedTeam);

      this.broadcastAdmins({ type: "request_resolved", requestId, status: action, by: actor, teamId: team.id });
      this.broadcastTeam(team.id, {
        type: "decision",
        requestId,
        clientReqId: req.clientReqId,
        requestType: req.type,
        action,
        status: updatedTeam.status,
      });

      this.store.addAudit({
        ts: now,
        type: `decide_${req.type}_${action}`,
        teamId: team.id,
        detail: JSON.stringify({ requestId }),
        actor,
      });
      return;
    }

    if (msg.type === "override_adjust") {
      const { teamId, deltaMs } = msg;
      const team = this.store.teams.get(teamId);
      if (!team) return;
      const updated = { ...team, remainingMsAtLastStop: team.remainingMsAtLastStop + deltaMs };
      this.commitTeam(updated);
      this.store.addAudit({
        ts: Date.now(),
        type: "override_adjust",
        teamId,
        detail: JSON.stringify({ deltaMs }),
        actor,
      });
      return;
    }

    if (msg.type === "override_force") {
      const { teamId, status } = msg as { teamId: string; status: "IN" | "OUT" };
      const team = this.store.teams.get(teamId);
      if (!team) return;
      const now = Date.now();
      const updated: Team =
        status === "IN"
          ? { ...team, status: "IN", runningSince: null, remainingMsAtLastStop: remainingMs(team, now) }
          : { ...team, status: "OUT", runningSince: now };
      this.commitTeam(updated);
      this.store.addAudit({
        ts: now,
        type: "override_force",
        teamId,
        detail: JSON.stringify({ status }),
        actor,
      });
      return;
    }
  }

  broadcastTeamExternal(team: Team) {
    this.broadcastTeamUpdate(team);
  }
}
