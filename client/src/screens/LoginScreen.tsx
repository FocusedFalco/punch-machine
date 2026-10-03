import { useState } from "preact/hooks";
import { teamLogin, adminLogin } from "../lib/api";
import { saveSession } from "../lib/session";
import type { SessionData } from "../lib/session";

function ClockIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}
function BellIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" stroke-linecap="round" stroke-linejoin="round" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}
function BriefcaseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="2" y="7" width="20" height="14" rx="2" />
      <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}
function ShieldIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}
function KeyIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="8" cy="15" r="4" />
      <path d="M11 12l9-9M17 6l2 2M14 9l2 2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}
function ClearIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="9" />
      <path d="M9 9l6 6M15 9l-6 6" stroke-linecap="round" />
    </svg>
  );
}
function BurstIcon() {
  return (
    <svg viewBox="0 0 24 24" width="34" height="34" fill="currentColor">
      <path d="M12 0l1.8 6.2L18 2l-1.3 6.3L22 6l-4.1 4.6L24 12l-6.1 1.4L22 18l-6.3-1.3L18 22l-6-4.2L12 24l-1.8-6.2L6 22l1.3-6.3L2 18l4.1-4.6L0 12l6.1-1.4L2 6l6.3 1.3L6 2l6 4.2z" />
    </svg>
  );
}

export function LoginScreen({ onLogin }: { onLogin: (s: SessionData) => void }) {
  const [mode, setMode] = useState<"team" | "admin">("team");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function formatCodeInput(v: string) {
    const clean = v.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
    return clean.length > 4 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
  }

  async function submit(e: Event) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "team") {
        const res = await teamLogin(code);
        saveSession({ role: "team", token: res.token, teamId: res.teamId, teamName: res.teamName });
        onLogin({ role: "team", token: res.token, teamId: res.teamId, teamName: res.teamName });
      } else {
        if (!name.trim()) throw new Error("enter your name");
        const res = await adminLogin(code, name.trim());
        saveSession({ role: "admin", token: res.token, adminName: res.name });
        onLogin({ role: "admin", token: res.token, adminName: res.name });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="screen login-screen-v2">
      <div class="login-header">
        <div class="login-header-left">
          <div class="login-icon-badge">
            <ClockIcon />
          </div>
          <div class="welcome-lockup">
            <span class="welcome-sub">Welcome to</span>
            <span class="welcome-title">OutTime</span>
          </div>
        </div>
        <div class="icon-btn" aria-hidden="true">
          <BellIcon />
        </div>
      </div>

      <div class="hero-card">
        <div class="hero-card-top">
          <h2 class="hero-headline">
            Ready to <em>track</em>
            <br />
            your shift today?
          </h2>
          <div class="hero-icon">
            <BurstIcon />
          </div>
        </div>
        <p class="hero-body">
          Enter your team's access code to go out, come back, and keep everyone's hours straight.
        </p>
        <div class="hero-status">
          <span class="status-dot" /> Live · real-time sync
        </div>
      </div>

      <div class="portal-select-row">
        <span class="portal-label">Select role</span>
        <span class="portal-current">Role: {mode === "team" ? "Team" : "Admin"}</span>
      </div>
      <div class="portal-toggle">
        <button
          type="button"
          class={`portal-card ${mode === "team" ? "active" : ""}`}
          onClick={() => {
            setMode("team");
            setError(null);
          }}
        >
          <BriefcaseIcon />
          Team
        </button>
        <button
          type="button"
          class={`portal-card ${mode === "admin" ? "active" : ""}`}
          onClick={() => {
            setMode("admin");
            setError(null);
          }}
        >
          <ShieldIcon />
          Admin
        </button>
      </div>

      <form onSubmit={submit} class="login-form-v2">
        <div class="field-label-row">
          <span class="field-label">
            <KeyIcon /> {mode === "team" ? "Access code" : "Admin code"}
          </span>
        </div>
        <div class="code-input-wrap">
          <input
            class="code-input-v2"
            placeholder={mode === "team" ? "XXXX-XXXX" : "Admin code"}
            value={code}
            maxLength={mode === "team" ? 9 : undefined}
            autofocus
            type="text"
            inputMode="text"
            autocapitalize="characters"
            autocomplete="off"
            autocorrect="off"
            spellcheck={false}
            enterkeyhint={mode === "team" ? "go" : "next"}
            onInput={(e) => {
              const v = (e.target as HTMLInputElement).value;
              setCode(mode === "team" ? formatCodeInput(v) : v);
            }}
          />
          {code && (
            <button type="button" class="clear-btn" aria-label="Clear" onClick={() => setCode("")}>
              <ClearIcon />
            </button>
          )}
        </div>

        {mode === "admin" && (
          <input
            class="name-input"
            placeholder="Your name"
            value={name}
            type="text"
            autocapitalize="words"
            autocomplete="name"
            enterkeyhint="go"
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
          />
        )}

        {error && <div class="error-text">{error}</div>}

        <button class="enter-btn-v2" type="submit" disabled={busy}>
          {busy ? "..." : (
            <>
              Enter <span class="arrow">→</span>
            </>
          )}
        </button>
      </form>
    </div>
  );
}
