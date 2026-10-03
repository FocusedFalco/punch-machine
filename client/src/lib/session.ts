export interface SessionData {
  role: "team" | "admin";
  token: string;
  teamId?: string;
  teamName?: string;
  adminName?: string;
}

const KEY = "outtime_session";

export function loadSession(): SessionData | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveSession(s: SessionData) {
  localStorage.setItem(KEY, JSON.stringify(s));
}

export function clearSession() {
  localStorage.removeItem(KEY);
}
