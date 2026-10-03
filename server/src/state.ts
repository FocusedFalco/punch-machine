import type { DB } from "./db.js";
import type { AuditEntry, RequestStatus, Session, Team, TeamRequest } from "./types.js";

export class Store {
  teams = new Map<string, Team>();
  teamsByCodeHash = new Map<string, string>(); // codeHash -> teamId
  // Holds every request for the lifetime of the process, not just pending
  // ones -- at hackathon scale (a few thousand requests over a few days)
  // this costs nothing, and it means idempotency checks (findByClientReqId)
  // and the race-atomicity check (resolveRequest) are pure in-memory
  // lookups, never a round trip to Postgres on the hot path. Callers that
  // want "pending only" (the admin queue, a team's own open request) filter
  // by status themselves.
  requests = new Map<string, TeamRequest>();
  sessions = new Map<string, Session>();

  private constructor(private db: DB, private totalOutMs: number) {}

  static async create(db: DB, totalOutMs: number): Promise<Store> {
    const store = new Store(db, totalOutMs);
    await store.rebuild();
    return store;
  }

  private async rebuild() {
    const teams = await this.db.query(`SELECT * FROM teams`);
    for (const row of teams.rows) {
      const team: Team = {
        id: row.id,
        name: row.name,
        leaderEmail: row.leader_email,
        codeHash: row.code_hash,
        status: row.status,
        remainingMsAtLastStop: Number(row.remaining_ms_at_last_stop),
        runningSince: row.running_since === null ? null : Number(row.running_since),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
      };
      this.teams.set(team.id, team);
      this.teamsByCodeHash.set(team.codeHash, team.id);
    }

    const requests = await this.db.query(`SELECT * FROM requests`);
    for (const row of requests.rows) {
      this.requests.set(row.id, {
        id: row.id,
        teamId: row.team_id,
        type: row.type,
        status: row.status,
        createdAt: Number(row.created_at),
        resolvedAt: row.resolved_at === null ? null : Number(row.resolved_at),
        resolvedBy: row.resolved_by,
        clientReqId: row.client_req_id,
      });
    }

    const sessions = await this.db.query(`SELECT * FROM sessions`);
    for (const row of sessions.rows) {
      this.sessions.set(row.token, {
        token: row.token,
        role: row.role,
        teamId: row.team_id,
        adminName: row.admin_name,
        createdAt: Number(row.created_at),
      });
    }
  }

  getTotalOutMs() {
    return this.totalOutMs;
  }

  private persist(sql: string, params: unknown[]) {
    // Fire-and-forget: the in-memory Map is already authoritative and the
    // broadcast has already gone out by the time this is called (see
    // ws.ts), so this only affects how soon a restart-recovery read would
    // see the change -- never request latency.
    this.db.query(sql, params).catch((err) => {
      console.error("[persist] query failed:", sql, err);
    });
  }

  // ---- persistence ----

  persistTeam(team: Team) {
    this.persist(
      `UPDATE teams SET status=$1, remaining_ms_at_last_stop=$2, running_since=$3, updated_at=$4 WHERE id=$5`,
      [team.status, team.remainingMsAtLastStop, team.runningSince, team.updatedAt, team.id]
    );
  }

  insertTeam(team: Team) {
    this.teams.set(team.id, team);
    this.teamsByCodeHash.set(team.codeHash, team.id);
    this.persist(
      `INSERT INTO teams (id, name, leader_email, code_hash, status, remaining_ms_at_last_stop, running_since, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        team.id,
        team.name,
        team.leaderEmail,
        team.codeHash,
        team.status,
        team.remainingMsAtLastStop,
        team.runningSince,
        team.createdAt,
        team.updatedAt,
      ]
    );
  }

  reissueCode(teamId: string, newCodeHash: string) {
    const team = this.teams.get(teamId);
    if (!team) return;
    this.teamsByCodeHash.delete(team.codeHash);
    team.codeHash = newCodeHash;
    this.teamsByCodeHash.set(newCodeHash, teamId);
    this.persist(`UPDATE teams SET code_hash=$1 WHERE id=$2`, [newCodeHash, teamId]);

    // Invalidate every existing session for this team immediately.
    for (const [token, s] of this.sessions) {
      if (s.teamId === teamId) this.sessions.delete(token);
    }
    this.persist(`DELETE FROM sessions WHERE team_id=$1`, [teamId]);
  }

  insertSession(session: Session) {
    this.sessions.set(session.token, session);
    this.persist(
      `INSERT INTO sessions (token, role, team_id, admin_name, created_at) VALUES ($1,$2,$3,$4,$5)`,
      [session.token, session.role, session.teamId, session.adminName, session.createdAt]
    );
  }

  insertRequest(req: TeamRequest) {
    this.requests.set(req.id, req);
    this.persist(
      `INSERT INTO requests (id, team_id, type, status, created_at, resolved_at, resolved_by, client_req_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [req.id, req.teamId, req.type, req.status, req.createdAt, req.resolvedAt, req.resolvedBy, req.clientReqId]
    );
  }

  /**
   * The single atomic decision point for admin race resolution: this only
   * succeeds if the request is still 'pending' at the moment it's called.
   * Node is single-threaded and this function has no `await` in it, so two
   * "simultaneous" decide calls can never both see 'pending' -- the second
   * one always observes the first's write. Returns the claimed request, or
   * undefined if someone else already resolved it (the caller's cue to
   * reply "already handled").
   */
  resolveRequest(reqId: string, status: RequestStatus, resolvedBy: string, resolvedAt: number): TeamRequest | undefined {
    const req = this.requests.get(reqId);
    if (!req || req.status !== "pending") return undefined;

    req.status = status;
    req.resolvedAt = resolvedAt;
    req.resolvedBy = resolvedBy;

    this.persist(`UPDATE requests SET status=$1, resolved_at=$2, resolved_by=$3 WHERE id=$4`, [
      status,
      resolvedAt,
      resolvedBy,
      reqId,
    ]);
    return req;
  }

  findByClientReqId(teamId: string, clientReqId: string): TeamRequest | undefined {
    for (const r of this.requests.values()) {
      if (r.teamId === teamId && r.clientReqId === clientReqId) return r;
    }
    return undefined;
  }

  findPendingForTeam(teamId: string): TeamRequest | undefined {
    for (const r of this.requests.values()) {
      if (r.teamId === teamId && r.status === "pending") return r;
    }
    return undefined;
  }

  getPendingRequests(): TeamRequest[] {
    return Array.from(this.requests.values()).filter((r) => r.status === "pending");
  }

  addAudit(entry: Omit<AuditEntry, "id">) {
    this.persist(`INSERT INTO audit_log (ts, type, team_id, detail, actor) VALUES ($1,$2,$3,$4,$5)`, [
      entry.ts,
      entry.type,
      entry.teamId,
      entry.detail,
      entry.actor,
    ]);
  }

}
