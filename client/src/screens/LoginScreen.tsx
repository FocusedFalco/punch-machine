import { useState } from "preact/hooks";
import { teamLogin, adminLogin } from "../lib/api";
import { saveSession } from "../lib/session";
import type { SessionData } from "../lib/session";

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
    <div class="screen login-screen">
      <h1 class="brand">OutTime</h1>
      <div class="mode-toggle">
        <button class={mode === "team" ? "active" : ""} onClick={() => setMode("team")}>
          Team
        </button>
        <button class={mode === "admin" ? "active" : ""} onClick={() => setMode("admin")}>
          Admin
        </button>
      </div>
      <form onSubmit={submit} class="login-form">
        {mode === "team" ? (
          <input
            class="code-input"
            placeholder="XXXX-XXXX"
            value={code}
            maxLength={9}
            autofocus
            type="text"
            inputMode="text"
            autocapitalize="characters"
            autocomplete="off"
            autocorrect="off"
            spellcheck={false}
            enterkeyhint="go"
            onInput={(e) => setCode(formatCodeInput((e.target as HTMLInputElement).value))}
          />
        ) : (
          <>
            <input
              class="code-input"
              placeholder="Admin code"
              value={code}
              autofocus
              type="text"
              inputMode="text"
              autocapitalize="characters"
              autocomplete="off"
              autocorrect="off"
              spellcheck={false}
              enterkeyhint="next"
              onInput={(e) => setCode((e.target as HTMLInputElement).value)}
            />
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
          </>
        )}
        {error && <div class="error-text">{error}</div>}
        <button class="primary-btn" type="submit" disabled={busy}>
          {busy ? "..." : "Enter"}
        </button>
      </form>
    </div>
  );
}
