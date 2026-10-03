import type { Team } from "./types.js";

/** remaining_ms(now) = remaining_ms_at_last_stop - (now - running_since) when running, else remaining_ms_at_last_stop. Can go negative (overtime). */
export function remainingMs(
  team: Pick<Team, "remainingMsAtLastStop" | "runningSince">,
  now: number
): number {
  if (team.runningSince === null) return team.remainingMsAtLastStop;
  return team.remainingMsAtLastStop - (now - team.runningSince);
}

export function isOvertime(team: Pick<Team, "remainingMsAtLastStop" | "runningSince">, now: number): boolean {
  return remainingMs(team, now) < 0;
}

export class StateError extends Error {}

/** Go Out tapped: IN -> OUT_PENDING. Clock does not start yet. */
export function applyGoOutRequest(team: Team): Team {
  if (team.status !== "IN") throw new StateError(`cannot go_out from ${team.status}`);
  return { ...team, status: "OUT_PENDING" };
}

/** Admin accepts Go Out: OUT_PENDING -> OUT, clock starts now. */
export function applyGoOutAccept(team: Team, now: number): Team {
  if (team.status !== "OUT_PENDING") throw new StateError(`cannot accept go_out from ${team.status}`);
  return { ...team, status: "OUT", runningSince: now };
}

/** Admin rejects Go Out: OUT_PENDING -> IN, nothing started. */
export function applyGoOutReject(team: Team): Team {
  if (team.status !== "OUT_PENDING") throw new StateError(`cannot reject go_out from ${team.status}`);
  return { ...team, status: "IN" };
}

/** Enter tapped: OUT -> RETURN_PENDING. Clock keeps running (not paused). */
export function applyEnterRequest(team: Team): Team {
  if (team.status !== "OUT") throw new StateError(`cannot enter from ${team.status}`);
  return { ...team, status: "RETURN_PENDING" };
}

/** Admin accepts Enter: RETURN_PENDING -> IN, clock stops now, remaining frozen (may be negative = overtime recorded). */
export function applyEnterAccept(team: Team, now: number): Team {
  if (team.status !== "RETURN_PENDING") throw new StateError(`cannot accept enter from ${team.status}`);
  const frozen = remainingMs(team, now);
  return { ...team, status: "IN", runningSince: null, remainingMsAtLastStop: frozen };
}

/** Admin rejects Enter: RETURN_PENDING -> OUT, clock never paused, keeps running. */
export function applyEnterReject(team: Team): Team {
  if (team.status !== "RETURN_PENDING") throw new StateError(`cannot reject enter from ${team.status}`);
  return { ...team, status: "OUT" };
}

export function canGoOut(team: Team, now: number): boolean {
  return team.status === "IN" && remainingMs(team, now) > 0;
}

export function canEnter(team: Team): boolean {
  return team.status === "OUT" || team.status === "RETURN_PENDING";
}

/** Admin override: force team IN immediately (stops clock, freezes remaining). */
export function applyForceIn(team: Team, now: number): Team {
  const frozen = remainingMs(team, now);
  return { ...team, status: "IN", runningSince: null, remainingMsAtLastStop: frozen };
}

/** Admin override: force team OUT immediately (starts clock now). */
export function applyForceOut(team: Team, now: number): Team {
  return { ...team, status: "OUT", runningSince: now };
}

/** Admin override: add/subtract minutes. Adjusts the stopped bank directly; if running, adjust remainingMsAtLastStop
 * which is equivalent to shifting the running baseline. */
export function applyAdjustMs(team: Team, deltaMs: number): Team {
  return { ...team, remainingMsAtLastStop: team.remainingMsAtLastStop + deltaMs };
}
