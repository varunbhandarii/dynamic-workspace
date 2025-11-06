export type SensorState =
  | "FOCUS"
  | "REVIEW"
  | "TRANSITION_TO_FOCUS"
  | "TRANSITION_TO_REVIEW";

export type CalibPhase = "REVIEW" | "FOCUS";

export type CalibStatusMsg = {
  type: "calib_status";
  status: "ok" | "error";
  reason?: string;
};

export type CalibResultPhaseMsg = {
  type: "calib_result_phase";
  phase: CalibPhase;
  mean: number;
  std: number;
  n: number;
  stable: boolean;
};

export type CalibDoneMsg = {
  type: "calib_done";
  saved?: any;
};

export type AnyMsg =
  | StateMsg
  | HeartbeatMsg
  | CalibStatusMsg
  | CalibResultPhaseMsg
  | CalibDoneMsg;

export function isCalibStatus(m: AnyMsg): m is CalibStatusMsg { return (m as any).type === "calib_status"; }
export function isCalibResultPhase(m: AnyMsg): m is CalibResultPhaseMsg { return (m as any).type === "calib_result_phase"; }
export function isCalibDone(m: AnyMsg): m is CalibDoneMsg { return (m as any).type === "calib_done"; }


export interface StateMsg {
  type: "state";
  state: SensorState;
}

export interface HeartbeatMsg {
  type: "hb";
  confidence?: number;
  health?: { status?: "OK" | "DEGRADED" | "PAUSED"; flags?: Record<string, boolean> };
  perf?: Record<string, unknown>;
  transition?: { target?: "FOCUS" | "REVIEW"; elapsed_ms?: number; required_ms?: number };
  state?: SensorState;
}

export function isStateMsg(x: any): x is StateMsg {
  return x && x.type === "state" && typeof x.state === "string";
}

export function isHBMsg(x: any): x is HeartbeatMsg {
  return x && x.type === "hb";
}
