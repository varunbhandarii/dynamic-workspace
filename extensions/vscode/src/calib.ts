import * as vscode from "vscode";
import type { ConnectionManager } from "./conn";
import type {
  AnyMsg,
  CalibPhase,
  CalibResultPhaseMsg,
  CalibDoneMsg
} from "./types";
import {
  isCalibResultPhase,
  isCalibDone
} from "./types";

type Waiter<T extends AnyMsg> = {
  test: (m: AnyMsg) => m is T;
  resolve: (m: T) => void;
  reject: (e: Error) => void;
  timeout: NodeJS.Timeout;
};

export class Calibrator {
  private waiters = new Set<Waiter<any>>();
  private active = false;

  constructor(private conn: ConnectionManager, private out: vscode.OutputChannel) {}

  handleMessage(msg: AnyMsg) {
    for (const w of Array.from(this.waiters)) {
      try {
        if (w.test(msg)) {
          clearTimeout(w.timeout);
          this.waiters.delete(w);
          w.resolve(msg);
        }
      } catch { /* ignore */ }
    }
  }

  async run(): Promise<void> {
    if (this.active) {
      vscode.window.showWarningMessage("Calibration already running.");
      return;
    }
    this.active = true;

    try {
      const ok = await vscode.window.showInformationMessage(
        "Calibration will measure your REVIEW (lean back) and FOCUS (lean in) distances.\n\nStep 1: Sit back at your normal review distance. Keep your head steady for ~3s.",
        { modal: true },
        "Start"
      );
      if (ok !== "Start") return;

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Dynamic Workspace: Calibration", cancellable: false },
        async (progress) => {
          progress.report({ message: "Step 1/2 — Lean back (sampling 3s)…", increment: 10 });
          this.conn.send({ cmd: "calibrate_phase", phase: "REVIEW", duration_s: 3.0 });

          const review = await this.waitFor<CalibResultPhaseMsg>(
            (m): m is CalibResultPhaseMsg => isCalibResultPhase(m) && m.phase === "REVIEW",
            12000,
            "Timed out waiting for Step 1 result"
          );
          this.out.appendLine(`[dw] calib REVIEW: mean=${review.mean} std=${review.std} n=${review.n} stable=${review.stable}`);
          progress.report({ message: `Step 1 done (mean=${review.mean.toFixed(2)})`, increment: 30 });

          const ok2 = await vscode.window.showInformationMessage(
            "Step 2: Lean in to your normal focus distance. Keep steady for ~3s.",
            { modal: true },
            "Start Step 2"
          );
          if (ok2 !== "Start Step 2") throw new Error("Calibration cancelled.");

          progress.report({ message: "Step 2/2 — Lean in (sampling 3s)…", increment: 15 });
          this.conn.send({ cmd: "calibrate_phase", phase: "FOCUS", duration_s: 3.0 });

          const focus = await this.waitFor<CalibResultPhaseMsg>(
            (m): m is CalibResultPhaseMsg => isCalibResultPhase(m) && m.phase === "FOCUS",
            12000,
            "Timed out waiting for Step 2 result"
          );
          this.out.appendLine(`[dw] calib FOCUS: mean=${focus.mean} std=${focus.std} n=${focus.n} stable=${focus.stable}`);
          progress.report({ message: `Step 2 done (mean=${focus.mean.toFixed(2)})`, increment: 25 });

          progress.report({ message: "Finalizing & saving…", increment: 10 });
          this.conn.send({ cmd: "calibrate_finalize" });

          const done = await this.waitFor<CalibDoneMsg>(
            (m): m is CalibDoneMsg => isCalibDone(m),
            10000,
            "Timed out waiting for calibration finalize"
          );

          const savedPretty = JSON.stringify(done.saved ?? {}, null, 2);
          this.out.appendLine(`[dw] calib DONE: saved=${savedPretty}`);

          await this.showSavedThresholds(savedPretty);
          progress.report({ message: "Calibration complete 🎉", increment: 15 });
        }
      );
    } catch (e: any) {
      vscode.window.showErrorMessage(`Calibration failed: ${e?.message ?? e}`);
    } finally {
      this.active = false;
    }
  }

  private waitFor<T extends AnyMsg>(
    test: (m: AnyMsg) => m is T,
    timeoutMs: number,
    timeoutMessage: string
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const w: Waiter<T> = {
        test,
        resolve,
        reject,
        timeout: setTimeout(() => {
          this.waiters.delete(w);
          reject(new Error(timeoutMessage));
        }, timeoutMs)
      };
      this.waiters.add(w);
    });
  }

  private async showSavedThresholds(jsonStr: string) {
    try {
      const doc = await vscode.workspace.openTextDocument({ language: "json", content: jsonStr });
      await vscode.window.showTextDocument(doc, { preview: true });
    } catch {
      vscode.window.showInformationMessage("Calibration complete. Thresholds saved by the sensor.");
    }
  }
}
