export type TeamStatus = "IN" | "OUT_PENDING" | "OUT" | "RETURN_PENDING";

export type RequestType = "go_out" | "enter";
export type RequestStatus = "pending" | "accepted" | "rejected";

export interface Team {
  id: string;
  name: string;
  leaderEmail: string;
  codeHash: string;
  status: TeamStatus;
  remainingMsAtLastStop: number;
  runningSince: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface TeamRequest {
  id: string;
  teamId: string;
  type: RequestType;
  status: RequestStatus;
  createdAt: number;
  resolvedAt: number | null;
  resolvedBy: string | null;
  clientReqId: string;
}

export interface AuditEntry {
  id: number;
  ts: number;
  type: string;
  teamId: string | null;
  detail: string;
  actor: string | null;
}

export interface Session {
  token: string;
  role: "team" | "admin";
  teamId: string | null;
  adminName: string | null;
  createdAt: number;
}

// Public team view sent to clients (no codeHash)
export interface TeamPublic {
  id: string;
  name: string;
  status: TeamStatus;
  remainingMsAtLastStop: number;
  runningSince: number | null;
  totalOutMs: number;
}

export function toPublicTeam(t: Team, totalOutMs: number): TeamPublic {
  return {
    id: t.id,
    name: t.name,
    status: t.status,
    remainingMsAtLastStop: t.remainingMsAtLastStop,
    runningSince: t.runningSince,
    totalOutMs,
  };
}
