import { useState } from "preact/hooks";
import { LoginScreen } from "./screens/LoginScreen";
import { TeamScreen } from "./screens/TeamScreen";
import { AdminScreen } from "./screens/AdminScreen";
import { clearSession, loadSession } from "./lib/session";
import type { SessionData } from "./lib/session";

export function App() {
  const [session, setSession] = useState<SessionData | null>(() => loadSession());

  function logout() {
    clearSession();
    setSession(null);
  }

  if (!session) return <LoginScreen onLogin={setSession} />;
  if (session.role === "team") return <TeamScreen session={session} onLogout={logout} />;
  return <AdminScreen session={session} onLogout={logout} />;
}
