import { useEffect, useRef, useState } from "preact/hooks";
import { WsClient } from "../lib/wsclient";
import { wsUrl } from "../lib/api";
import { clock } from "../lib/clock";
import { formatDuration } from "../lib/format";
import type { TeamPublic } from "../types";
import type { SessionData } from "../lib/session";

type LocalStatus = TeamPublic["status"] | "GOING_OUT_OPTIMISTIC" | "ENTERING_OPTIMISTIC";

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
      <div class="screen team-screen">
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

  return (
    <div class="screen team-screen">
      <div class="top-bar">
        <span class="team-name">{session.teamName}</span>
        {connState !== "open" && <span class="conn-badge">reconnecting…</span>}
        <button class="link-btn" onClick={onLogout}>
          logout
        </button>
      </div>

      <div class={`countdown ${overtime ? "overtime" : ""}`}>
        {overtime ? `+${formatDuration(-remaining)} over` : formatDuration(remaining)}
      </div>
      <div class="status-label">{statusLabel(effectiveStatus)}</div>

      {isPending && <div class="banner pending-banner">Waiting for admin…</div>}
      {toast && <div class="banner toast-banner">{toast}</div>}

      <div class="action-area">
        {isIn && !exhausted && (
          <button class="action-btn go-out" disabled={isPending} onClick={() => send("go_out")}>
            Go Out
          </button>
        )}
        {isIn && exhausted && <div class="exhausted-box">Time exhausted</div>}
        {(isOut || effectiveStatus === "RETURN_PENDING" || effectiveStatus === "ENTERING_OPTIMISTIC") && (
          <button class="action-btn enter" disabled={effectiveStatus !== "OUT"} onClick={() => send("enter")}>
            Enter
          </button>
        )}
        {effectiveStatus === "GOING_OUT_OPTIMISTIC" && <button class="action-btn go-out" disabled>Go Out</button>}
      </div>
    </div>
  );
}

function statusLabel(s: LocalStatus): string {
  switch (s) {
    case "IN":
      return "Currently IN";
    case "OUT":
      return "Currently OUT";
    case "OUT_PENDING":
    case "GOING_OUT_OPTIMISTIC":
      return "Requesting to go out";
    case "RETURN_PENDING":
    case "ENTERING_OPTIMISTIC":
      return "Requesting to enter";
  }
}
