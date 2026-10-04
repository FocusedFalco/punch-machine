import { useEffect, useRef, useState } from "preact/hooks";
import { WsClient } from "../lib/wsclient";
import { wsUrl } from "../lib/api";
import { clock } from "../lib/clock";
import { formatDuration } from "../lib/format";
import type { TeamPublic } from "../types";
import type { SessionData } from "../lib/session";

type LocalStatus = TeamPublic["status"] | "GOING_OUT_OPTIMISTIC" | "ENTERING_OPTIMISTIC";

function ExitIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}
function GoOutIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M11 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5M16 16l4-4-4-4M20 12H9" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}
function EnterIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M13 4h5a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-5M8 16l-4-4 4-4M4 12h11" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

export function TeamScreen({ session, onLogout }: { session: SessionData; onLogout: () => void }) {
  const [team, setTeam] = useState<TeamPublic | null>(null);
  const [optimistic, setOptimistic] = useState<"go_out" | "enter" | null>(null);
  const [connState, setConnState] = useState<"connecting" | "open" | "closed">("connecting");
  const [now, setNow] = useState(() => clock.now());
  const [toast, setToast] = useState<string | null>(null);
  const wsRef = useRef<WsClient | null>(null);
  const pendingClientReqId = useRef<string | null>(null);

  useEffect(() => {
    const ws = new WsClient(() => wsUrl(session.token));
    wsRef.current = ws;

    ws.on("snapshot", (msg) => setTeam(msg.team));
    ws.on("team_update", (msg) => setTeam(msg.team));
    ws.on("decision", (msg) => {
      setOptimistic(null);
      setToast(msg.action === "accept" ? "Approved" : "Rejected");
      setTimeout(() => setToast(null), 2500);
    });
    ws.on("error", (msg) => {
      setOptimistic(null);
      setToast(msg.message ?? "Error");
      setTimeout(() => setToast(null), 3000);
    });
    ws.on("request_ack", () => {
      // server confirmed; optimistic state stays until admin decides
    });
    ws.on("kicked", (msg) => {
      setToast(msg.reason === "removed" ? "Your team was removed by an admin" : "You were logged out by an admin");
      setTimeout(onLogout, 2000);
    });
    ws.onConnState(setConnState);
    ws.connect();

    return () => ws.close();
  }, [session.token]);

  useEffect(() => {
    const id = setInterval(() => setNow(clock.now()), 250);
    return () => clearInterval(id);
  }, []);

  if (!team) {
    return (
      <div class="screen team-screen-v2">
        <div class="loading">Loading…</div>
      </div>
    );
  }

  const running = team.runningSince !== null;
  const remaining = running ? team.remainingMsAtLastStop - (now - team.runningSince!) : team.remainingMsAtLastStop;
  const overtime = remaining < 0;
  const exhausted = remaining <= 0;
  const effectiveStatus: LocalStatus = optimistic === "go_out" ? "GOING_OUT_OPTIMISTIC" : optimistic === "enter" ? "ENTERING_OPTIMISTIC" : team.status;

  function send(type: "go_out" | "enter") {
    const clientReqId = crypto.randomUUID();
    pendingClientReqId.current = clientReqId;
    setOptimistic(type);
    const ok = wsRef.current?.send({ type, clientReqId });
    if (!ok) {
      setOptimistic(null);
      setToast("Not connected — try again");
      setTimeout(() => setToast(null), 2500);
    }
  }

  const isPending = effectiveStatus === "OUT_PENDING" || effectiveStatus === "RETURN_PENDING" || effectiveStatus === "GOING_OUT_OPTIMISTIC" || effectiveStatus === "ENTERING_OPTIMISTIC";
  const isIn = effectiveStatus === "IN";
  const isOut = effectiveStatus === "OUT";

  const heroTone = overtime ? "red" : isPending ? "amber" : isOut ? "amber" : "green";
  const durationStr = overtime ? formatDuration(-remaining) : formatDuration(remaining);
  const [hh, mm, ss] = durationStr.split(":");

  return (
    <div class="screen team-screen-v2">
      <div class="team-header">
        <div class="team-header-left">
          <span class={`online-dot ${connState === "open" ? "online" : "offline"}`} aria-hidden="true" />
          <div class="welcome-lockup">
            <span class="welcome-sub">Welcome back</span>
            <span class="welcome-title">{session.teamName}</span>
          </div>
        </div>
        <button class="link-btn" onClick={onLogout}>
          <ExitIcon />Exit
        </button>
      </div>

      <div class={`hero-card team-hero team-hero--${heroTone}`}>
        <div class="request-hero-badge">
          <span class="status-dot-live" /> {statusLabel(effectiveStatus).toUpperCase()}
        </div>
        <h2 class="hero-headline">{heroHeadline(effectiveStatus, overtime)}</h2>
        <p class="hero-body">{heroBody(effectiveStatus, overtime, exhausted)}</p>
        <div class="team-countdown-row">
          <div class="team-countdown-label">{overtime ? "Overtime" : "Remaining time"}</div>
          <div class="team-countdown-value">
            {overtime && <span class="countdown-plus">+</span>}
            {hh}
            <span class="countdown-sep">:</span>
            {mm}
            <span class="countdown-sep">:</span>
            <span class="countdown-accent">{ss}</span>
          </div>
        </div>
      </div>

      {isPending && <div class="banner pending-banner">Waiting for admin…</div>}
      {toast && <div class="banner toast-banner">{toast}</div>}

      <div class="action-area-v2">
        {isIn && !exhausted && (
          <button class="action-card action-card--go" disabled={isPending} onClick={() => send("go_out")}>
            <span class="action-card-icon">
              <GoOutIcon />
            </span>
            <span class="action-card-text">
              <strong>Go Out</strong>
              <span>Tap to start your out-time</span>
            </span>
            <span class="action-card-arrow">→</span>
          </button>
        )}
        {isIn && exhausted && <div class="exhausted-box">Time exhausted</div>}
        {(isOut || effectiveStatus === "RETURN_PENDING" || effectiveStatus === "ENTERING_OPTIMISTIC") && (
          <button class="action-card action-card--enter" disabled={effectiveStatus !== "OUT"} onClick={() => send("enter")}>
            <span class="action-card-icon">
              <EnterIcon />
            </span>
            <span class="action-card-text">
              <strong>Enter</strong>
              <span>Tap when you're back</span>
            </span>
            <span class="action-card-arrow">→</span>
          </button>
        )}
        {effectiveStatus === "GOING_OUT_OPTIMISTIC" && (
          <button class="action-card action-card--go" disabled>
            <span class="action-card-icon">
              <GoOutIcon />
            </span>
            <span class="action-card-text">
              <strong>Go Out</strong>
              <span>Sending request…</span>
            </span>
          </button>
        )}
      </div>
    </div>
  );
}

function statusLabel(s: LocalStatus): string {
  switch (s) {
    case "IN":
      return "Currently in";
    case "OUT":
      return "Currently out";
    case "OUT_PENDING":
    case "GOING_OUT_OPTIMISTIC":
      return "Requesting to go out";
    case "RETURN_PENDING":
    case "ENTERING_OPTIMISTIC":
      return "Requesting to enter";
  }
}

function heroHeadline(s: LocalStatus, overtime: boolean) {
  if (overtime) {
    return (
      <>
        You're <em>over</em> your time
      </>
    );
  }
  switch (s) {
    case "IN":
      return (
        <>
          Ready to head <em>out</em>?
        </>
      );
    case "OUT":
      return (
        <>
          Currently <em>out</em>
        </>
      );
    case "OUT_PENDING":
    case "GOING_OUT_OPTIMISTIC":
      return (
        <>
          Request <em>sent</em>
        </>
      );
    case "RETURN_PENDING":
    case "ENTERING_OPTIMISTIC":
      return (
        <>
          Heading <em>back in</em>
        </>
      );
  }
}

function heroBody(s: LocalStatus, overtime: boolean, exhausted: boolean): string {
  if (overtime) return "Your out-time has run out. Tap Enter as soon as you're back.";
  switch (s) {
    case "IN":
      return exhausted
        ? "You're out of out-time for this event."
        : "Your time bank is full and ready whenever you need to step out.";
    case "OUT":
      return "Your time is running. Tap Enter when you're back.";
    case "OUT_PENDING":
    case "GOING_OUT_OPTIMISTIC":
      return "An admin needs to approve this before your clock starts.";
    case "RETURN_PENDING":
    case "ENTERING_OPTIMISTIC":
      return "Your clock keeps running until an admin confirms you're back.";
  }
}
