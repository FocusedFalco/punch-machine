import { useEffect, useRef, useState } from "preact/hooks";
import { WsClient } from "../lib/wsclient";
import { reissueCode, wsUrl } from "../lib/api";
import { clock } from "../lib/clock";
import { formatAgo, formatDuration } from "../lib/format";
import type { RequestView, TeamPublic } from "../types";
import type { SessionData } from "../lib/session";

const ORIGINAL_TITLE = "OutTime Admin";

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5">
      <path d="M5 13l4 4L19 7" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}
function XIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5">
      <path d="M6 6l12 12M18 6L6 18" stroke-linecap="round" />
    </svg>
  );
}
function TicketIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="3" y="7" width="18" height="10" rx="2" />
      <path d="M9 7v10" stroke-dasharray="2 2" />
    </svg>
  );
}
function PeopleIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="9" cy="8" r="3" />
      <path d="M2 20c0-3.3 3.1-6 7-6s7 2.7 7 6" stroke-linecap="round" />
      <path d="M16 4.5a3 3 0 0 1 0 7M22 20c0-2.8-2.3-5.1-5.3-5.8" stroke-linecap="round" />
    </svg>
  );
}
function ArrowInIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M13 3h6v18h-6M10 12H3m0 0l4-4m-4 4l4 4" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}
function ArrowOutIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M11 3H5v18h6M14 12h7m0 0l-4-4m4 4l-4 4" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}
function HourglassIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M6 3h12M6 21h12M7 3c0 5 10 5 10 0M7 21c0-5 10-5 10 0" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}
function ExitIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

export function AdminScreen({ session, onLogout }: { session: SessionData; onLogout: () => void }) {
  const [teams, setTeams] = useState<Map<string, TeamPublic>>(new Map());
  const [requests, setRequests] = useState<Map<string, RequestView>>(new Map());
  const [connState, setConnState] = useState<"connecting" | "open" | "closed">("connecting");
  const [now, setNow] = useState(() => clock.now());
  const [muted, setMuted] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [overrideTeam, setOverrideTeam] = useState<TeamPublic | null>(null);
  const [tab, setTab] = useState<"requests" | "teams">("requests");
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
    ws.on("team_removed", (msg) => {
      setTeams((prev) => {
        const next = new Map(prev);
        next.delete(msg.teamId);
        return next;
      });
      setOverrideTeam((prev) => (prev?.id === msg.teamId ? null : prev));
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
    const ok = wsRef.current?.send({ type: "decide", requestId, action });
    if (!ok) {
      setToast("Not connected — reconnecting, try again in a moment");
      setTimeout(() => setToast(null), 2500);
    }
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

  const inCount = teamList.filter((t) => t.status === "IN").length;
  const outCount = teamList.filter((t) => t.status === "OUT").length;
  const pendingCount = teamList.filter((t) => t.status === "OUT_PENDING" || t.status === "RETURN_PENDING").length;

  const [featured, ...restRequests] = requestList;

  return (
    <div class="screen admin-screen">
      <div class="top-bar">
        <span class="team-name">Admin: {session.adminName}</span>
        {connState !== "open" && <span class="conn-badge">reconnecting…</span>}
        <button class="link-btn" onClick={() => setMuted((m) => !m)}>
          {muted ? "🔇 unmute" : "🔊 mute"}
        </button>
        <button class="link-btn" onClick={onLogout}>
          <ExitIcon />Exit
        </button>
      </div>

      {toast && <div class="banner toast-banner">{toast}</div>}

      {alerts.length > 0 && (
        <div class="alert-box">
          ⚠ Overtime: {alerts.map((a) => a.name).join(", ")}
        </div>
      )}

      <div class="admin-tabs">
        <button type="button" class={`admin-tab ${tab === "requests" ? "active" : ""}`} onClick={() => setTab("requests")}>
          Requests {requestList.length > 0 && <span class="tab-badge">{requestList.length}</span>}
        </button>
        <button type="button" class={`admin-tab ${tab === "teams" ? "active" : ""}`} onClick={() => setTab("teams")}>
          Teams
        </button>
      </div>

      {tab === "requests" ? (
        <>
          <div class="status-strip">
            <div class="status-tile">
              <div class="status-tile-icon status-tile-icon--all">
                <PeopleIcon />
              </div>
              <div class="status-tile-count">{teamList.length}</div>
              <div class="status-tile-label">All</div>
            </div>
            <div class="status-tile">
              <div class="status-tile-icon status-tile-icon--in">
                <ArrowInIcon />
              </div>
              <div class="status-tile-count">{inCount}</div>
              <div class="status-tile-label">In</div>
            </div>
            <div class="status-tile">
              <div class="status-tile-icon status-tile-icon--out">
                <ArrowOutIcon />
              </div>
              <div class="status-tile-count">{outCount}</div>
              <div class="status-tile-label">Out</div>
            </div>
            <div class="status-tile">
              <div class="status-tile-icon status-tile-icon--pending">
                <HourglassIcon />
              </div>
              <div class="status-tile-count">{pendingCount}</div>
              <div class="status-tile-label">Pending</div>
            </div>
          </div>

          {featured ? (
            <div class="hero-card request-hero">
              <div class="request-hero-badge">
                <span class="status-dot-live" /> PENDING REQUESTS ({requestList.length})
              </div>
              <h2 class="hero-headline">
                Ready to review the <em>next</em> request?
              </h2>
              <div class="featured-request">
                <div class="featured-request-icon">
                  <TicketIcon />
                </div>
                <div class="featured-request-info">
                  <strong>{featured.teamName}</strong>
                  <span>{featured.type === "go_out" ? "Go Out" : "Enter"}</span>
                </div>
                <div class="featured-request-wait">
                  WAITING
                  <br />
                  {formatAgo(now - featured.createdAt)}
                </div>
              </div>
              <div class="hero-actions">
                <button class="hero-accept-btn" onClick={() => decide(featured.id, "accept")}>
                  <CheckIcon />Accept
                </button>
                <button class="hero-reject-btn" onClick={() => decide(featured.id, "reject")}>
                  <XIcon />Reject
                </button>
              </div>
            </div>
          ) : (
            <div class="empty-hero">No pending requests right now.</div>
          )}

          {restRequests.length > 0 && (
            <section class="queue-section">
              <h2>Also waiting ({restRequests.length})</h2>
              <div class="queue-list">
                {restRequests.map((r) => (
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
          )}
        </>
      ) : (
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
      )}

      {overrideTeam && (
        <OverridePanel
          team={overrideTeam}
          token={session.token}
          onClose={() => setOverrideTeam(null)}
          onAdjust={(deltaMs) => wsRef.current?.send({ type: "override_adjust", teamId: overrideTeam.id, deltaMs })}
          onForce={(status) => wsRef.current?.send({ type: "override_force", teamId: overrideTeam.id, status })}
          onLogoutTeam={() => wsRef.current?.send({ type: "override_logout", teamId: overrideTeam.id })}
          onRemove={() => {
            wsRef.current?.send({ type: "override_remove", teamId: overrideTeam.id });
            setOverrideTeam(null);
          }}
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
  onLogoutTeam,
  onRemove,
}: {
  team: TeamPublic;
  token: string;
  onClose: () => void;
  onAdjust: (deltaMs: number) => void;
  onForce: (status: "IN" | "OUT") => void;
  onLogoutTeam: () => void;
  onRemove: () => void;
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

  function doRemove() {
    if (confirm(`Remove ${team.name}? Their code stops working immediately and this can't be undone.`)) {
      onRemove();
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
        <div class="modal-row">
          <button onClick={onLogoutTeam}>Log out team's devices</button>
        </div>
        <div class="modal-row">
          <button class="danger-btn" onClick={doRemove}>
            Remove team
          </button>
        </div>
        <button class="link-btn" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
