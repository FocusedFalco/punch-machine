import { describe, expect, it } from "vitest";
import {
  applyEnterAccept,
  applyEnterReject,
  applyEnterRequest,
  applyGoOutAccept,
  applyGoOutReject,
  applyGoOutRequest,
  applyAdjustMs,
  applyForceIn,
  applyForceOut,
  canEnter,
  canGoOut,
  isOvertime,
  remainingMs,
  StateError,
} from "../server/src/time.js";
import type { Team } from "../server/src/types.js";

const TOTAL = 7 * 3600 * 1000;

function makeTeam(overrides: Partial<Team> = {}): Team {
  return {
    id: "t1",
    name: "Team One",
    leaderEmail: "a@b.com",
    codeHash: "hash",
    status: "IN",
    remainingMsAtLastStop: TOTAL,
    runningSince: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("remainingMs", () => {
  it("returns the stopped bank when not running", () => {
    const t = makeTeam({ remainingMsAtLastStop: 1000, runningSince: null });
    expect(remainingMs(t, 999999)).toBe(1000);
  });

  it("subtracts elapsed time when running", () => {
    const t = makeTeam({ remainingMsAtLastStop: 10000, runningSince: 1000 });
    expect(remainingMs(t, 4000)).toBe(7000);
  });

  it("can go negative (overtime)", () => {
    const t = makeTeam({ remainingMsAtLastStop: 1000, runningSince: 0 });
    expect(remainingMs(t, 5000)).toBe(-4000);
    expect(isOvertime(t, 5000)).toBe(true);
  });
});

describe("Go Out flow", () => {
  it("accept starts the clock", () => {
    const t = makeTeam({ status: "OUT_PENDING", runningSince: null });
    const after = applyGoOutAccept(t, 5000);
    expect(after.status).toBe("OUT");
    expect(after.runningSince).toBe(5000);
  });

  it("reject returns to IN with nothing started", () => {
    const t = makeTeam({ status: "OUT_PENDING" });
    const after = applyGoOutReject(t);
    expect(after.status).toBe("IN");
    expect(after.runningSince).toBeNull();
  });

  it("request transitions IN -> OUT_PENDING", () => {
    const t = makeTeam({ status: "IN" });
    const after = applyGoOutRequest(t);
    expect(after.status).toBe("OUT_PENDING");
    expect(after.runningSince).toBeNull();
  });

  it("rejects go_out from a non-IN state", () => {
    const t = makeTeam({ status: "OUT" });
    expect(() => applyGoOutRequest(t)).toThrow(StateError);
  });
});

describe("Enter flow", () => {
  it("pending (Enter tapped) does NOT stop the clock", () => {
    const t = makeTeam({ status: "OUT", runningSince: 1000, remainingMsAtLastStop: 10000 });
    const after = applyEnterRequest(t);
    expect(after.status).toBe("RETURN_PENDING");
    expect(after.runningSince).toBe(1000); // unchanged, still running
    expect(after.remainingMsAtLastStop).toBe(10000);
  });

  it("accept stops the clock and freezes remaining", () => {
    const t = makeTeam({ status: "RETURN_PENDING", runningSince: 1000, remainingMsAtLastStop: 10000 });
    const after = applyEnterAccept(t, 4000);
    expect(after.status).toBe("IN");
    expect(after.runningSince).toBeNull();
    expect(after.remainingMsAtLastStop).toBe(7000); // 10000 - (4000-1000)
  });

  it("reject keeps the clock running (never paused)", () => {
    const t = makeTeam({ status: "RETURN_PENDING", runningSince: 1000, remainingMsAtLastStop: 10000 });
    const after = applyEnterReject(t);
    expect(after.status).toBe("OUT");
    expect(after.runningSince).toBe(1000); // still running, untouched
    expect(after.remainingMsAtLastStop).toBe(10000);
  });

  it("overtime goes negative and is recorded on accept", () => {
    const t = makeTeam({ status: "RETURN_PENDING", runningSince: 0, remainingMsAtLastStop: 1000 });
    const after = applyEnterAccept(t, 5000);
    expect(after.remainingMsAtLastStop).toBe(-4000);
    expect(after.status).toBe("IN");
  });
});

describe("guards", () => {
  it("exhausted team (remaining <= 0) cannot go out", () => {
    const t = makeTeam({ status: "IN", remainingMsAtLastStop: 0 });
    expect(canGoOut(t, 0)).toBe(false);
  });

  it("exhausted team while OUT can still enter", () => {
    const t = makeTeam({ status: "OUT", remainingMsAtLastStop: -100, runningSince: 0 });
    expect(canEnter(t)).toBe(true);
  });

  it("a team with time remaining can go out", () => {
    const t = makeTeam({ status: "IN", remainingMsAtLastStop: 1 });
    expect(canGoOut(t, 0)).toBe(true);
  });
});

describe("admin overrides", () => {
  it("adjust adds/subtracts minutes from the bank", () => {
    const t = makeTeam({ remainingMsAtLastStop: 10000 });
    expect(applyAdjustMs(t, 5000).remainingMsAtLastStop).toBe(15000);
    expect(applyAdjustMs(t, -5000).remainingMsAtLastStop).toBe(5000);
  });

  it("force IN stops a running clock and freezes remaining", () => {
    const t = makeTeam({ status: "OUT", runningSince: 0, remainingMsAtLastStop: 10000 });
    const after = applyForceIn(t, 3000);
    expect(after.status).toBe("IN");
    expect(after.runningSince).toBeNull();
    expect(after.remainingMsAtLastStop).toBe(7000);
  });

  it("force OUT starts the clock immediately", () => {
    const t = makeTeam({ status: "IN", runningSince: null, remainingMsAtLastStop: 10000 });
    const after = applyForceOut(t, 3000);
    expect(after.status).toBe("OUT");
    expect(after.runningSince).toBe(3000);
  });
});
