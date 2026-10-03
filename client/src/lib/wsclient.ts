import { clock } from "./clock";

type Handler = (msg: any) => void;

export class WsClient {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<Handler>>();
  private backoffMs = 300;
  private readonly maxBackoffMs = 3000;
  private closedByUser = false;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private connStateHandlers = new Set<(state: "connecting" | "open" | "closed") => void>();

  constructor(private url: () => string) {}

  on(type: string, handler: Handler) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(handler);
    return () => this.handlers.get(type)?.delete(handler);
  }

  onConnState(fn: (state: "connecting" | "open" | "closed") => void) {
    this.connStateHandlers.add(fn);
    return () => this.connStateHandlers.delete(fn);
  }

  private emitConn(state: "connecting" | "open" | "closed") {
    for (const fn of this.connStateHandlers) fn(state);
  }

  connect() {
    this.closedByUser = false;
    this.open();
  }

  private open() {
    this.emitConn("connecting");
    const ws = new WebSocket(this.url());
    this.ws = ws;

    ws.onopen = () => {
      this.backoffMs = 300;
      this.emitConn("open");
      this.doPingBurst(5, 150);
      if (this.pingInterval) clearInterval(this.pingInterval);
      this.pingInterval = setInterval(() => {
        clock.resetRttFloor();
        this.doPingBurst(3, 150);
      }, 60000);
    };

    ws.onmessage = (ev) => {
      let msg: any;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === "pong") {
        clock.sample(msg.t, msg.s, Date.now());
        return;
      }
      const set = this.handlers.get(msg.type);
      set?.forEach((h) => h(msg));
      this.handlers.get("*")?.forEach((h) => h(msg));
    };

    ws.onclose = () => {
      this.emitConn("closed");
      if (this.pingInterval) clearInterval(this.pingInterval);
      if (this.closedByUser) return;
      setTimeout(() => this.open(), this.backoffMs);
      this.backoffMs = Math.min(this.maxBackoffMs, this.backoffMs * 1.7);
    };

    ws.onerror = () => {
      ws.close();
    };
  }

  private doPingBurst(count: number, spacingMs: number) {
    let sent = 0;
    const fire = () => {
      if (sent >= count || this.ws?.readyState !== WebSocket.OPEN) return;
      this.ws.send(JSON.stringify({ type: "ping", t: Date.now() }));
      sent++;
      if (sent < count) setTimeout(fire, spacingMs);
    };
    fire();
  }

  send(msg: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  close() {
    this.closedByUser = true;
    this.ws?.close();
  }
}
