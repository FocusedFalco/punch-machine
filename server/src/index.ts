import { openDb } from "./db.js";
import { Store } from "./state.js";
import { buildApp, attachWebSocketServer } from "./http.js";

const PORT = Number(process.env.PORT ?? 8080);
const ADMIN_CODE = process.env.ADMIN_CODE ?? "ADMIN-DEV";
const HMAC_SECRET = process.env.HMAC_SECRET ?? "dev-secret-change-me";
const TOTAL_OUT_MS = Number(process.env.TOTAL_OUT_MS ?? 7 * 3600 * 1000);
const DB_PATH = process.env.DB_PATH ?? "./data/outtime.db";
const CLIENT_DIST = process.env.CLIENT_DIST ?? undefined;

if (!process.env.HMAC_SECRET) {
  console.warn("[WARN] HMAC_SECRET not set, using insecure dev default. Set it in production.");
}
if (!process.env.ADMIN_CODE) {
  console.warn("[WARN] ADMIN_CODE not set, using insecure dev default. Set it in production.");
}

const db = openDb(DB_PATH);
const store = new Store(db, TOTAL_OUT_MS);

const { app, hub } = buildApp(store, {
  adminCode: ADMIN_CODE,
  hmacSecret: HMAC_SECRET,
  totalOutMs: TOTAL_OUT_MS,
  port: PORT,
  clientDist: CLIENT_DIST,
});

await app.ready();
attachWebSocketServer(app, hub, store);

app.listen({ port: PORT, host: "0.0.0.0" }, (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`OutTime server listening on ${address}`);
  console.log(`Total out time: ${TOTAL_OUT_MS / 1000 / 60} minutes`);
});
