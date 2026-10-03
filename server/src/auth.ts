import crypto from "node:crypto";

const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // no look-alikes (no 0/O/1/I/L)
const CODE_LEN = 8;

export function generateCode(): string {
  let out = "";
  for (let i = 0; i < CODE_LEN; i++) {
    out += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  }
  return out;
}

export function formatCode(raw: string): string {
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
}

/** Normalize user input: uppercase, strip dashes/spaces, map common look-alikes defensively. */
export function normalizeCodeInput(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function hashCode(normalizedCode: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(normalizedCode).digest("hex");
}

export function generateToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** Simple in-memory sliding-window rate limiter per key (IP). Only `recordFailure` consumes
 * a slot; `isBlocked` is a read-only check, so successful attempts are never throttled. */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private limit: number, private windowMs: number) {}

  isBlocked(key: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    this.hits.set(key, recent);
    return recent.length >= this.limit;
  }

  recordFailure(key: string) {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    recent.push(now);
    this.hits.set(key, recent);
  }

  sweep() {
    const cutoff = Date.now() - this.windowMs;
    for (const [k, arr] of this.hits) {
      const recent = arr.filter((t) => t > cutoff);
      if (recent.length === 0) this.hits.delete(k);
      else this.hits.set(k, recent);
    }
  }
}
