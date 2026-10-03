const API_BASE = ""; // same-origin; Vite dev proxy forwards /api to the server

export async function teamLogin(code: string): Promise<{ token: string; teamId: string; teamName: string }> {
  const res = await fetch(`${API_BASE}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? "login failed");
  return res.json();
}

export async function adminLogin(code: string, name: string): Promise<{ token: string; name: string }> {
  const res = await fetch(`${API_BASE}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, name }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? "login failed");
  return res.json();
}

export async function reissueCode(token: string, teamId: string): Promise<{ code: string }> {
  const res = await fetch(`${API_BASE}/api/admin/reissue`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ teamId }),
  });
  if (!res.ok) throw new Error("reissue failed");
  return res.json();
}

export function auditCsvUrl(token: string) {
  return `${API_BASE}/api/admin/audit.csv?token=${encodeURIComponent(token)}`;
}

export function wsUrl(token: string) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`;
}
