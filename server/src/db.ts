import pg from "pg";

const { Pool } = pg;
export type DB = pg.Pool;

/**
 * All ids are TEXT (not Postgres uuid) and timestamps are BIGINT epoch-ms
 * (not timestamptz) on purpose: this keeps every value here byte-identical
 * to what the in-memory Store already works with (see state.ts / time.ts),
 * so persisting is a straight pass-through with zero mapping logic on the
 * hot path.
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS teams (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    leader_email TEXT NOT NULL,
    code_hash TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    remaining_ms_at_last_stop BIGINT NOT NULL,
    running_since BIGINT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    role TEXT NOT NULL,
    team_id TEXT,
    admin_name TEXT,
    created_at BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_team_id ON sessions(team_id);

  CREATE TABLE IF NOT EXISTS requests (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    resolved_at BIGINT,
    resolved_by TEXT,
    client_req_id TEXT NOT NULL,
    UNIQUE(team_id, client_req_id)
  );
  CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);

  CREATE TABLE IF NOT EXISTS audit_log (
    id BIGSERIAL PRIMARY KEY,
    ts BIGINT NOT NULL,
    type TEXT NOT NULL,
    team_id TEXT,
    detail TEXT,
    actor TEXT
  );
`;

export async function openDb(connectionString: string): Promise<DB> {
  const pool = new Pool({
    connectionString,
    // Render <-> Supabase is a handful of long-lived connections from one
    // persistent process, not a serverless fan-out -- a small pool plus
    // Supabase's session pooler (port 5432, not the 6543 transaction
    // pooler meant for serverless) is the right shape here.
    max: 5,
    ssl: connectionString.includes("localhost") ? false : { rejectUnauthorized: false },
  });
  await pool.query(SCHEMA);
  return pool;
}
