import Database from "better-sqlite3";
import type { Database as DB } from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export function openDb(filePath: string): DB {
  const dir = path.dirname(filePath);
  if (dir && dir !== ".") fs.mkdirSync(dir, { recursive: true });
  const db = new Database(filePath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  migrate(db);
  return db;
}

function migrate(db: DB) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      leader_email TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      remaining_ms_at_last_stop INTEGER NOT NULL,
      running_since INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_teams_code_hash ON teams(code_hash);

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      team_id TEXT,
      admin_name TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_team_id ON sessions(team_id);

    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      resolved_at INTEGER,
      resolved_by TEXT,
      client_req_id TEXT NOT NULL,
      UNIQUE(team_id, client_req_id)
    );
    CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      type TEXT NOT NULL,
      team_id TEXT,
      detail TEXT,
      actor TEXT
    );
  `);
}

export type { DB };
