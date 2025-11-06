import * as vscode from "vscode";
import WebSocket from "ws";
import { isHBMsg, isStateMsg } from "./types";
import type { AnyMsg } from "./types";

type ConnStatus = "connecting" | "connected" | "stale" | "disconnected";

export interface ConnEvents {
  onMessage: (msg: AnyMsg) => void;
  onStatus: (s: ConnStatus) => void;
}

export class ConnectionManager {
  private ws: WebSocket | null = null;
  private timers: { watchdog?: NodeJS.Timeout; reconnect?: NodeJS.Timeout } = {};
  private lastSeen = 0;
  private backoffMs = 500;
  private readonly maxBackoff = 5000;

  constructor(
    private url: string,
    private heartbeatMs: number,
    private ev: ConnEvents
  ) {}

  start() {
    this.connect();
    this.startWatchdog();
  }

  dispose() {
    if (this.timers.watchdog) clearInterval(this.timers.watchdog);
    if (this.timers.reconnect) clearTimeout(this.timers.reconnect);
    try { this.ws?.close(); } catch {}
    this.ws = null;
  }

  private connect() {
    this.ev.onStatus("connecting");
    try { this.ws?.close(); } catch {}
    this.ws = new WebSocket(this.url);

    this.ws.on("open", () => {
      this.lastSeen = Date.now();
      this.backoffMs = 500;
      this.ev.onStatus("connected");
    });

    this.ws.on("message", (raw: WebSocket.RawData) => {
      this.lastSeen = Date.now();
      let json: any;
      try { json = JSON.parse(raw.toString()); } catch { return; }
      this.ev.onMessage(json);
    });

    this.ws.on("close", () => {
      this.scheduleReconnect();
      this.ev.onStatus("disconnected");
    });

    this.ws.on("error", () => {
      try { this.ws?.close(); } catch {}
    });
  }

  private scheduleReconnect() {
    if (this.timers.reconnect) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoff);
    this.timers.reconnect = setTimeout(() => {
      this.timers.reconnect = undefined;
      this.connect();
    }, delay);
  }

  private startWatchdog() {
    if (this.timers.watchdog) return;
    this.timers.watchdog = setInterval(() => {
      const now = Date.now();
      const silentFor = now - this.lastSeen;
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        if (silentFor > this.heartbeatMs) {
          this.ev.onStatus("stale");
          if (silentFor > this.heartbeatMs * 2) {
            try { this.ws?.close(); } catch {}
          }
        }
      }
    }, Math.max(500, Math.min(2000, this.heartbeatMs / 2)));
  }

  send(obj: any) {
    try {
      const s = this.ws;
      if (s && s.readyState === s.OPEN) s.send(JSON.stringify(obj));
    } catch { /* ignore */ }
  }

  restart() {
    try { this.dispose(); } catch {}
    this.start();
  }

}
