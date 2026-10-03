import fs from "node:fs";
import crypto from "node:crypto";
import { openDb } from "./db.js";
import { generateCode, formatCode, hashCode, normalizeCodeInput } from "./auth.js";

// Usage: npm run seed -- teams.csv [output.csv]
// Input CSV: team_name,leader_email (header row optional)
// Output CSV: team_name,leader_email,access_code

const HMAC_SECRET = process.env.HMAC_SECRET;
if (!HMAC_SECRET) {
  console.error("ERROR: HMAC_SECRET env var must be set to seed teams (same secret the server uses).");
  process.exit(1);
}

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: npm run seed -- <input.csv> [output.csv]");
  process.exit(1);
}
const outputPath = process.argv[3] ?? inputPath.replace(/\.csv$/i, "") + "_with_codes.csv";
const DB_PATH = process.env.DB_PATH ?? "./data/outtime.db";

const raw = fs.readFileSync(inputPath, "utf-8");
const lines = raw
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l.length > 0);

let rows = lines.map((l) => l.split(",").map((c) => c.trim()));
if (rows[0] && rows[0][0]?.toLowerCase().includes("team")) {
  rows = rows.slice(1); // drop header
}

const db = openDb(DB_PATH);
const insert = db.prepare(
  `INSERT INTO teams (id, name, leader_email, code_hash, status, remaining_ms_at_last_stop, running_since, created_at, updated_at)
   VALUES (@id, @name, @leaderEmail, @codeHash, 'IN', @remaining, NULL, @now, @now)`
);
const TOTAL_OUT_MS = Number(process.env.TOTAL_OUT_MS ?? 7 * 3600 * 1000);

const out: string[] = ["team_name,leader_email,access_code"];
const seen = new Set<string>();

const insertAll = db.transaction((entries: { name: string; email: string; raw: string; hash: string }[]) => {
  for (const e of entries) {
    insert.run({
      id: crypto.randomUUID(),
      name: e.name,
      leaderEmail: e.email,
      codeHash: e.hash,
      remaining: TOTAL_OUT_MS,
      now: Date.now(),
    });
  }
});

const entries: { name: string; email: string; raw: string; hash: string }[] = [];
for (const [name, email] of rows) {
  if (!name) continue;
  let rawCode: string;
  let hash: string;
  do {
    rawCode = generateCode();
    hash = hashCode(rawCode, HMAC_SECRET);
  } while (seen.has(hash));
  seen.add(hash);
  entries.push({ name, email: email ?? "", raw: rawCode, hash });
  out.push(`${name},${email ?? ""},${formatCode(rawCode)}`);
}

insertAll(entries);

fs.writeFileSync(outputPath, out.join("\n") + "\n");
console.log(`Seeded ${entries.length} teams into ${DB_PATH}`);
console.log(`Plaintext codes written to ${outputPath} -- distribute securely and delete after sharing.`);
