import type { SensorState, StateMsg, HeartbeatMsg } from "./types";

export type Mode = "FOCUS" | "REVIEW";

export interface PolicyOutput {
  effectiveMode: Mode;
  isTransitioning: boolean;
  canAdapt: boolean;
  reason: string;
  confidence: number;
  health: { status: "OK" | "DEGRADED" | "PAUSED"; flags: Record<string, boolean> };
  transition: { target: Mode | null; elapsed_ms: number; required_ms: number };
}

type Overrides = {
  paused: boolean;
  snoozeUntil: number;
  forceMode: Mode | null;
};

export class PolicyEngine {
  private defaultMode: Mode = "FOCUS";
  private lastStable: Mode = "FOCUS";
  private sensorState: SensorState = "FOCUS";
  private confidence = 0;
  private health: PolicyOutput["health"] = { status: "OK", flags: {} };
  private transition: PolicyOutput["transition"] = { target: null, elapsed_ms: 0, required_ms: 0 };

  private uiConfMin: number;
  private overrides: Overrides = { paused: false, snoozeUntil: 0, forceMode: null };

  constructor(uiConfMin = 0.5) {
    this.uiConfMin = uiConfMin;
  }

  ingestState(m: StateMsg) {
    this.sensorState = m.state;
    if (m.state === "FOCUS" || m.state === "REVIEW") this.lastStable = m.state;
  }

  ingestHB(hb: HeartbeatMsg) {
    if (typeof hb.confidence === "number") this.confidence = hb.confidence;
    if (hb.health) this.health = { status: (hb.health.status as any) || "OK", flags: hb.health.flags || {} };
    if (hb.transition) this.transition = {
      target: (hb.transition.target as Mode) ?? null,
      elapsed_ms: hb.transition.elapsed_ms ?? 0,
      required_ms: hb.transition.required_ms ?? 0,
    };
  }

  setOverride(next: Partial<Overrides>) {
    this.overrides = { ...this.overrides, ...next };
  }
  clearOverride() {
    this.overrides = { paused: false, snoozeUntil: 0, forceMode: null };
  }
  setAdaptationEnabled(flag: boolean) {
    this.overrides.paused = !flag;
  }

  compute(): PolicyOutput {
    const healthPaused = this.health.status === "PAUSED";
    const healthDegraded = this.health.status === "DEGRADED";
    const now = Date.now();
    const snoozed = this.overrides.snoozeUntil > now;

    let effective: Mode = this.lastStable || this.defaultMode;
    let isTransitioning = false;
    let canAdapt = true;
    let reason = "FALLBACK";

    if (healthPaused) {
      return this.mk(effective, false, false, "HEALTH_PAUSED");
    }

    if (this.overrides.forceMode) {
      effective = this.overrides.forceMode;
      reason = "FORCED";
      if (healthDegraded) reason += "_DEGRADED";
      return this.mk(effective, false, true, reason);
    }

    if (this.overrides.paused || snoozed) {
      reason = this.overrides.paused ? "PAUSED_BY_USER" : "SNOOZED";
      return this.mk(effective, false, false, reason);
    }

    const s = this.sensorState;
    const confOK = this.confidence >= this.uiConfMin;

    if (s === "FOCUS" || s === "REVIEW") {
      effective = s;
      reason = "SENSOR_STABLE";
    } else if (s === "TRANSITION_TO_FOCUS" || s === "TRANSITION_TO_REVIEW") {
      isTransitioning = true;
      const target: Mode = s.endsWith("FOCUS") ? "FOCUS" : "REVIEW";
      effective = confOK ? target : this.lastStable;
      reason = confOK ? "TRANSITION_PREVIEW" : "TRANSITION_LOWCONF";
    } else {
      reason = "UNKNOWN_HOLD";
    }

    if (healthDegraded) reason += "_DEGRADED";
    return this.mk(effective, isTransitioning, true, reason);
  }

  private mk(effectiveMode: Mode, isTransitioning: boolean, canAdapt: boolean, reason: string): PolicyOutput {
    return { effectiveMode, isTransitioning, canAdapt, reason, confidence: this.confidence, health: this.health, transition: this.transition };
  }
}
