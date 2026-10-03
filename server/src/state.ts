import type { DB } from "./db.js";
import type { AuditEntry, RequestStatus, RequestType, Session, Team, TeamRequest, TeamStatus } from "./types.js";

export class Store {
  teams = new Map<string, Team>();
  teamsByCodeHash = new Map<string, string>(); // codeHash -> teamId
  requests = new Map<string, TeamRequest>(); // pending requests only, in memory
  sessions = new Map<string, Session>();

  constructor(private db: DB, private totalOutMs: number) {
    this.rebuild();
  }

  private rebuild() {
    const teams = this.db.prepare(`SELECT * FROM teams`).all() as any[];
    for (const row of teams) {
      const team: Team = {
        id: row.id,
        name: row.name,
        leaderEmail: row.leader_email,
        codeHash: row.code_hash,
        status: row.status,
        remainingMsAtLastStop: row.remaining_ms_at_last_stop,
        runningSince: row.running_since,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
      this.teams.set(team.id, team);
      this.teamsByCodeHash.set(team.codeHash, team.id);
    }
    const requests = this.db.prepare(`SELECT * FROM requests WHERE status = 'pending'`).all() as any[];
    for (const row of requests) {
      this.requests.set(row.id, {
        id: row.id,
        teamId: row.team_id,
        type: row.type,
        status: row.status,
        createdAt: row.created_at,
        resolvedAt: row.resolved_at,
        resolvedBy: row.resolved_by,
        clientReqId: row.client_req_id,
      });
    }
    const sessions = this.db.prepare(`SELECT * FROM sessions`).all() as any[];
    for (const row of sessions) {
      this.sessions.set(row.token, {
        token: row.token,
        role: row.role,
        teamId: row.team_id,
        adminName: row.admin_name,
        createdAt: row.created_at,
      });
    }
  }

  getTotalOutMs() {
    return this.totalOutMs;
  }

  // ---- persistence (deferred so it never blocks the synchronous broadcast call) ----

  persistTeam(team: Team) {
    setImmediate(() => {
      this.db
        .prepare(
          `UPDATE teams SET status=?, remaining_ms_at_last_stop=?, running_since=?, updated_at=? WHERE id=?`
        )
        .run(team.status, team.remainingMsAtLastStop, team.runningSince, team.updatedAt, team.id);
    });
  }

  insertTeam(team: Team) {
    this.teams.set(team.id, team);
    this.teamsByCodeHash.set(team.codeHash, team.id);
    this.db
      .prepare(
        `INSERT INTO teams (id, name, leader_email, code_hash, status, remaining_ms_at_last_stop, running_since, created_at, updated_at)
         VALUES (@id, @name, @leaderEmail, @codeHash, @status, @remainingMsAtLastStop, @runningSince, @createdAt, @updatedAt)`
      )
      .run(team);
  }

  reissueCode(teamId: string, newCodeHash: string) {
    const team = this.teams.get(teamId);
    if (!team) return;
    this.teamsByCodeHash.delete(team.codeHash);
    team.codeHash = newCodeHash;
    this.teamsByCodeHash.set(newCodeHash, teamId);
    this.db.prepare(`UPDATE teams SET code_hash=? WHERE id=?`).run(newCodeHash, teamId);
    // Invalidate existing team sessions for this team immediately.
    for (const [token, s] of this.sessions) {
      if (s.teamId === teamId) this.sessions.delete(token);
    }
    this.db.prepare(`DELETE FROM sessions WHERE team_id=?`).run(teamId);
  }

  insertSession(session: Session) {
    this.sessions.set(session.token, session);
    setImmediate(() => {
      this.db
        .prepare(
          `INSERT INTO sessions (token, role, team_id, admin_name, created_at) VALUES (@token,@role,@teamId,@adminName,@createdAt)`
        )
        .run(session);
    });
  }

  insertRequest(req: TeamRequest) {
    this.requests.set(req.id, req);
    setImmediate(() => {
      this.db
        .prepare(
          `INSERT INTO requests (id, team_id, type, status, created_at, resolved_at, resolved_by, client_req_id)
           VALUES (@id,@teamId,@type,@status,@createdAt,@resolvedAt,@resolvedBy,@clientReqId)`
        )
        .run(req);
    });
  }

  resolveRequest(reqId: string, status: RequestStatus, resolvedBy: string, resolvedAt: number) {
    const req = this.requests.get(reqId);
    this.requests.delete(reqId);
    setImmediate(() => {
      this.db
        .prepare(`UPDATE requests SET status=?, resolved_at=?, resolved_by=? WHERE id=?`)
        .run(status, resolvedAt, resolvedBy, reqId);
    });
    return req;
  }

  /** Find an existing (pending or resolved) request for idempotency check. */
  findByClientReqId(teamId: string, clientReqId: string): TeamRequest | undefined {
    for (const r of this.requests.values()) {
      if (r.teamId === teamId && r.clientReqId === clientReqId) return r;
    }
    const row = this.db
      .prepare(`SELECT * FROM requests WHERE team_id=? AND client_req_id=?`)
      .get(teamId, clientReqId) as any;
    if (!row) return undefined;
    return {
      id: row.id,
      teamId: row.team_id,
      type: row.type,
      status: row.status,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at,
      resolvedBy: row.resolved_by,
      clientReqId: row.client_req_id,
    };
  }

  addAudit(entry: Omit<AuditEntry, "id">) {
    setImmediate(() => {
      this.db
        .prepare(`INSERT INTO audit_log (ts, type, team_id, detail, actor) VALUES (?,?,?,?,?)`)
        .run(entry.ts, entry.type, entry.teamId, entry.detail, entry.actor);
    });
  }

  getAuditLog(limit = 1000): AuditEntry[] {
    const rows = this.db
      .prepare(`SELECT * FROM audit_log ORDER BY id DESC LIMIT ?`)
      .all(limit) as any[];
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      type: r.type,
      teamId: r.team_id,
      detail: r.detail,
      actor: r.actor,
    }));
  }

  getAllAuditLog(): AuditEntry[] {
    const rows = this.db.prepare(`SELECT * FROM audit_log ORDER BY id ASC`).all() as any[];
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      type: r.type,
      teamId: r.team_id,
      detail: r.detail,
      actor: r.actor,
    }));
  }
}
