import fs from "node:fs";
import crypto from "node:crypto";
import { openDb } from "./db.js";
import { generateCode, formatCode, hashCode } from "./auth.js";

// Usage: npm run seed -- teams.csv [output.csv]
// Input CSV: team_name (header row optional, one name per line also works)
// Output CSV: team_name,access_code

const HMAC_SECRET = process.env.HMAC_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;
if (!HMAC_SECRET) {
  console.error("ERROR: HMAC_SECRET env var must be set to seed teams (same secret the server uses).");
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL env var must be set (your Supabase/Postgres connection string).");
  process.exit(1);
}

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: npm run seed -- <input.csv> [output.csv]");
  process.exit(1);
}
const outputPath = process.argv[3] ?? inputPath.replace(/\.csv$/i, "") + "_with_codes.csv";
const TOTAL_OUT_MS = Number(process.env.TOTAL_OUT_MS ?? 7 * 3600 * 1000);

const raw = fs.readFileSync(inputPath, "utf-8");
const lines = raw
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l.length > 0);

let rows = lines.map((l) => l.split(",").map((c) => c.trim()));
if (rows[0] && rows[0][0]?.toLowerCase().includes("team")) {
  rows = rows.slice(1); // drop header
}

const db = await openDb(DATABASE_URL);

const out: string[] = ["team_name,access_code"];
const seen = new Set<string>();
let count = 0;

for (const [name] of rows) {
  if (!name) continue;
  let rawCode: string;
  let hash: string;
  do {
    rawCode = generateCode();
    hash = hashCode(rawCode, HMAC_SECRET);
  } while (seen.has(hash));
  seen.add(hash);

  const now = Date.now();
  await db.query(
    `INSERT INTO teams (id, name, code_hash, status, remaining_ms_at_last_stop, running_since, created_at, updated_at)
     VALUES ($1,$2,$3,'IN',$4,NULL,$5,$5)`,
    [crypto.randomUUID(), name, hash, TOTAL_OUT_MS, now]
  );
  out.push(`${name},${formatCode(rawCode)}`);
  count++;
}

fs.writeFileSync(outputPath, out.join("\n") + "\n");
console.log(`Seeded ${count} teams into Postgres.`);
console.log(`Plaintext codes written to ${outputPath} -- distribute securely and delete after sharing.`);

await db.end();
