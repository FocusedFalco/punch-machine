import { useEffect, useRef, useState } from "preact/hooks";
import { WsClient } from "../lib/wsclient";
import { reissueCode, wsUrl } from "../lib/api";
import { clock } from "../lib/clock";
import { formatAgo, formatDuration } from "../lib/format";
import type { RequestView, TeamPublic } from "../types";
import type { SessionData } from "../lib/session";

const ORIGINAL_TITLE = "OutTime Admin";

export function AdminScreen({ session, onLogout }: { session: SessionData; onLogout: () => void }) {
  const [teams, setTeams] = useState<Map<string, TeamPublic>>(new Map());
  const [requests, setRequests] = useState<Map<string, RequestView>>(new Map());
  const [connState, setConnState] = useState<"connecting" | "open" | "closed">("connecting");
  const [now, setNow] = useState(() => clock.now());
  const [muted, setMuted] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [overrideTeam, setOverrideTeam] = useState<TeamPublic | null>(null);
  const wsRef = useRef<WsClient | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const flashRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function playChime() {
    if (muted) return;
    try {
      const ctx = audioCtxRef.current ?? new AudioContext();
      audioCtxRef.current = ctx;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.4);
      osc.start();
      osc.stop(ctx.currentTime + 0.4);
    } catch {
      // ignore audio errors (autoplay restrictions, etc.)
    }
  }

  function flashTitle() {
    if (flashRef.current) return;
    let on = false;
    flashRef.current = setInterval(() => {
      document.title = on ? ORIGINAL_TITLE : "🔔 New request!";
      on = !on;
    }, 800);
  }

  function stopFlash() {
    if (flashRef.current) {
      clearInterval(flashRef.current);
      flashRef.current = null;
      document.title = ORIGINAL_TITLE;
    }
  }

  useEffect(() => {
    const ws = new WsClient(() => wsUrl(session.token));
    wsRef.current = ws;

    ws.on("snapshot", (msg) => {
      setTeams(new Map(msg.teams.map((t: TeamPublic) => [t.id, t])));
      setRequests(new Map(msg.requests.map((r: RequestView) => [r.id, r])));
    });
    ws.on("team_update", (msg) => {
      setTeams((prev) => {
        const next = new Map(prev);
        next.set(msg.team.id, msg.team);
        return next;
      });
    });
    ws.on("request_new", (msg) => {
      setRequests((prev) => {
        const next = new Map(prev);
        next.set(msg.request.id, msg.request);
        return next;
      });
      playChime();
      flashTitle();
    });
    ws.on("request_resolved", (msg) => {
      setRequests((prev) => {
        const next = new Map(prev);
        next.delete(msg.requestId);
        return next;
      });
    });
    ws.on("already_handled", (msg) => {
      setToast(`Already handled by ${msg.by}`);
      setTimeout(() => setToast(null), 2500);
      setRequests((prev) => {
        const next = new Map(prev);
        next.delete(msg.requestId);
        return next;
      });
    });
    ws.onConnState(setConnState);
    ws.connect();

    return () => {
      ws.close();
      stopFlash();
    };
  }, [session.token]);

  useEffect(() => {
    const id = setInterval(() => setNow(clock.now()), 500);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === "visible") stopFlash();
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  function decide(requestId: string, action: "accept" | "reject") {
    stopFlash();
    wsRef.current?.send({ type: "decide", requestId, action });
  }

  function remainingFor(t: TeamPublic) {
    return t.runningSince !== null ? t.remainingMsAtLastStop - (now - t.runningSince) : t.remainingMsAtLastStop;
  }

  const teamList = Array.from(teams.values()).sort((a, b) => a.name.localeCompare(b.name));
  const requestList = Array.from(requests.values()).sort((a, b) => a.createdAt - b.createdAt);
  const alerts = teamList.filter((t) => {
    const r = remainingFor(t);
    return (t.status === "OUT" || t.status === "RETURN_PENDING") && r <= 0;
  });

  return (
    <div class="screen admin-screen">
      <div class="top-bar">
        <span class="team-name">Admin: {session.adminName}</span>
        {connState !== "open" && <span class="conn-badge">reconnecting…</span>}
        <button class="link-btn" onClick={() => setMuted((m) => !m)}>
          {muted ? "🔇 unmute" : "🔊 mute"}
        </button>
        <button class="link-btn" onClick={onLogout}>
          logout
        </button>
      </div>

      {toast && <div class="banner toast-banner">{toast}</div>}

      {alerts.length > 0 && (
        <div class="alert-box">
          ⚠ Overtime: {alerts.map((a) => a.name).join(", ")}
        </div>
      )}

      <section class="queue-section">
        <h2>Pending requests ({requestList.length})</h2>
        {requestList.length === 0 && <div class="empty">No pending requests</div>}
        <div class="queue-list">
          {requestList.map((r) => (
            <div class="queue-item" key={r.id}>
              <div class="queue-info">
                <strong>{r.teamName}</strong>
                <span class="req-type">{r.type === "go_out" ? "Go Out" : "Enter"}</span>
                <span class="req-wait">waiting {formatAgo(now - r.createdAt)}</span>
              </div>
              <div class="queue-actions">
                <button class="accept-btn" onClick={() => decide(r.id, "accept")}>
                  Accept
                </button>
                <button class="reject-btn" onClick={() => decide(r.id, "reject")}>
                  Reject
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section class="grid-section">
        <h2>Teams ({teamList.length})</h2>
        <div class="team-grid">
          {teamList.map((t) => {
            const r = remainingFor(t);
            const overtime = r < 0;
            return (
              <div
                class={`team-card status-${t.status} ${overtime ? "overtime" : ""}`}
                key={t.id}
                onClick={() => setOverrideTeam(t)}
              >
                <div class="team-card-name">{t.name}</div>
                <div class="team-card-status">{t.status.replace("_", " ")}</div>
                <div class={`team-card-time ${overtime ? "overtime" : ""}`}>
                  {overtime ? `+${formatDuration(-r)}` : formatDuration(r)}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {overrideTeam && (
        <OverridePanel
          team={overrideTeam}
          token={session.token}
          onClose={() => setOverrideTeam(null)}
          onAdjust={(deltaMs) => wsRef.current?.send({ type: "override_adjust", teamId: overrideTeam.id, deltaMs })}
          onForce={(status) => wsRef.current?.send({ type: "override_force", teamId: overrideTeam.id, status })}
        />
      )}
    </div>
  );
}

function OverridePanel({
  team,
  token,
  onClose,
  onAdjust,
  onForce,
}: {
  team: TeamPublic;
  token: string;
  onClose: () => void;
  onAdjust: (deltaMs: number) => void;
  onForce: (status: "IN" | "OUT") => void;
}) {
  const [newCode, setNewCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function doReissue() {
    setBusy(true);
    try {
      const res = await reissueCode(token, team.id);
      setNewCode(res.code);
    } catch {
      setNewCode("error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="modal-backdrop" onClick={onClose}>
      <div class="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{team.name}</h3>
        <p>Status: {team.status}</p>
        <div class="modal-row">
          <button onClick={() => onAdjust(5 * 60000)}>+5 min</button>
          <button onClick={() => onAdjust(-5 * 60000)}>-5 min</button>
          <button onClick={() => onAdjust(15 * 60000)}>+15 min</button>
          <button onClick={() => onAdjust(-15 * 60000)}>-15 min</button>
        </div>
        <div class="modal-row">
          <button onClick={() => onForce("IN")}>Force IN</button>
          <button onClick={() => onForce("OUT")}>Force OUT</button>
        </div>
        <div class="modal-row">
          <button disabled={busy} onClick={doReissue}>
            Reissue code
          </button>
          {newCode && <span class="new-code">{newCode}</span>}
        </div>
        <button class="link-btn" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
