export type TeamStatus = "IN" | "OUT_PENDING" | "OUT" | "RETURN_PENDING";

export interface TeamPublic {
  id: string;
  name: string;
  status: TeamStatus;
  remainingMsAtLastStop: number;
  runningSince: number | null;
  totalOutMs: number;
}

export interface RequestView {
  id: string;
  teamId: string;
  teamName: string;
  type: "go_out" | "enter";
  status: "pending" | "accepted" | "rejected";
  createdAt: number;
}

export interface AuditEntry {
  id: number;
  ts: number;
  type: string;
  teamId: string | null;
  detail: string;
  actor: string | null;
}
