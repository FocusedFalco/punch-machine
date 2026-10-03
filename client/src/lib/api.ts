// The backend (Render) is a different origin than this frontend (Vercel), so
// every call needs an absolute base URL -- set at build time via Vite env.
const API_BASE = import.meta.env.VITE_API_BASE as string;

if (!API_BASE) {
  console.error("VITE_API_BASE is not set -- point it at your Render backend's URL.");
}

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

export function wsUrl(token: string) {
  const wsBase = API_BASE.replace(/^http/, "ws");
  return `${wsBase}/ws?token=${encodeURIComponent(token)}`;
}
