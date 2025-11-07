import * as vscode from "vscode";
import { ConnectionManager } from "./conn";
import { PolicyEngine } from "./policy";
import { isHBMsg, isStateMsg } from "./types";
import type { AnyMsg } from "./types";
import { ModeApplier } from "./apply";
import { UxController } from "./ux";
import { Calibrator } from "./calib";
import { SensorProcessManager } from "./sensorProc";
import { installOrUpdateSensor } from "./sensorDownload";

let conn: ConnectionManager | null = null;
let sensorProc: SensorProcessManager | null = null;

type Waiter = { test: (m: AnyMsg) => boolean; resolve: (m: AnyMsg) => void; timeout: NodeJS.Timeout; };
const waiters = new Set<Waiter>();
function waitFor(test: (m: AnyMsg) => boolean, timeoutMs: number, onTimeout: string): Promise<AnyMsg> {
  return new Promise((resolve, reject) => {
    const w: Waiter = {
      test,
      resolve: (m) => { clearTimeout(w.timeout); waiters.delete(w); resolve(m); },
      timeout: setTimeout(() => { waiters.delete(w); reject(new Error(onTimeout)); }, timeoutMs)
    };
    waiters.add(w);
  });
}

export function activate(ctx: vscode.ExtensionContext) {
  const cfg = vscode.workspace.getConfiguration("dynamicWorkspace");
  const url = cfg.get<string>("sensorUrl", "ws://localhost:8765");
  const uiConfMin = cfg.get<number>("uiConfMin", 0.5);
  const heartbeatMs = cfg.get<number>("heartbeatMs", 4000);

  const out = vscode.window.createOutputChannel("Dynamic Workspace");
  out.appendLine(`[dw] activating — url=${url} uiConfMin=${uiConfMin}`);

  sensorProc = new SensorProcessManager(out);
  sensorProc.startFromConfig(ctx);

  const policy = new PolicyEngine(uiConfMin);
  const applier = new ModeApplier(out);

  let calibrator: Calibrator | null = null;

  conn = new ConnectionManager(url, heartbeatMs, {
    onMessage: (msg: AnyMsg) => {
      if (isStateMsg(msg)) policy.ingestState(msg);
      else if (isHBMsg(msg)) policy.ingestHB(msg);

      calibrator?.handleMessage(msg);

      for (const w of Array.from(waiters)) {
        try {
          if (w.test(msg)) {
            w.resolve(msg);
          }
        } catch {}
      }

      const p = policy.compute();
      logPolicy(out, p);
      applier.schedule(p);
      ux.render(p);
    },
    onStatus: (s) => {
      out.appendLine(`[dw] connection: ${s}`);
    }
  });
  conn.start();

  const ux = new UxController(ctx, policy, applier, conn, out);
  calibrator = new Calibrator(conn, out);

  ctx.subscriptions.push(
    vscode.commands.registerCommand("dynamicWorkspace.calibrate", () => calibrator.run()),

    vscode.commands.registerCommand("dynamicWorkspace.selectCamera", async () => {
      if (!conn) return;
      try {
        conn.send({ cmd: "cameras" });
        const m = await waitFor(
          (x: any) => x && x.type === "cameras" && Array.isArray(x.list),
          4000,
          "Camera probe timed out"
        ) as any;

        const list: number[] = m.list || [];
        const cur: number = m.current ?? 0;

        const picks = list.map(i => ({
          label: `Camera ${i}`,
          description: i === cur ? "current" : "",
          value: i
        }));
        picks.push({ label: "Enter index…", description: "Manual entry", value: -1 });

        const choice = await vscode.window.showQuickPick(picks, { placeHolder: "Select camera index" });
        if (!choice) return;

        let index = choice.value;
        if (index === -1) {
          const s = await vscode.window.showInputBox({ prompt: "Enter camera index (0,1,2…)", validateInput: v => /^\d+$/.test(v) ? undefined : "Must be a non-negative integer" });
          if (!s) return;
          index = Number(s);
        }

        conn.send({ cmd: "switch_camera", index });
        vscode.window.showInformationMessage(`Dynamic Workspace: switching camera to index ${index}…`);

        const config = vscode.workspace.getConfiguration("dynamicWorkspace");
        if (config.get<boolean>("autoStartSensor", false)) {
          await config.update("cameraIndex", index, vscode.ConfigurationTarget.Global);
          out.appendLine(`[dw] cameraIndex saved to settings: ${index}`);
        }
      } catch (e: any) {
        const picks = [0,1,2,3].map(i => ({ label: `Camera ${i}`, value: i }));
        const choice = await vscode.window.showQuickPick(picks, { placeHolder: "Select camera index (fallback)" });
        if (choice) {
          conn.send({ cmd: "switch_camera", index: choice.value });
        }
        vscode.window.showWarningMessage(`Camera listing failed: ${e?.message || e}`);
      }
    }),

    vscode.commands.registerCommand("dynamicWorkspace.startSensor", () => {
      sensorProc?.startFromConfig();
    }),
    vscode.commands.registerCommand("dynamicWorkspace.stopSensor", () => {
      sensorProc?.stop();
    }),
    vscode.commands.registerCommand("dynamicWorkspace.installSensor", async () => {
  const bin = await installOrUpdateSensor(ctx, out);
  if (bin) {
    await vscode.workspace.getConfiguration("dynamicWorkspace")
      .update("sensorPath", bin, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage("Dynamic Workspace: Sensor installed.");
  }
}),

  );

  const d1 = vscode.window.onDidChangeActiveTextEditor(() => applier.editorChanged());
  const d2 = vscode.workspace.onDidOpenTextDocument(() => applier.editorChanged());
  const d3 = vscode.window.onDidChangeTextEditorVisibleRanges((e) => applier.noteScroll(e));

  const d4 = vscode.workspace.onDidChangeConfiguration(async (e) => {
    if (!e.affectsConfiguration("dynamicWorkspace")) return;
    const cfg = vscode.workspace.getConfiguration("dynamicWorkspace");
    if (e.affectsConfiguration("dynamicWorkspace.autoStartSensor") ||
        e.affectsConfiguration("dynamicWorkspace.sensorPath") ||
        e.affectsConfiguration("dynamicWorkspace.sensorArgs") ||
        e.affectsConfiguration("dynamicWorkspace.cameraIndex") ||
        e.affectsConfiguration("dynamicWorkspace.sensorUrl")) {
      const auto = cfg.get<boolean>("autoStartSensor", false);
      if (auto) sensorProc?.restart(ctx); else sensorProc?.stop();
    }
  });

  ctx.subscriptions.push(d1, d2, d3, d4, {
    dispose() {
      conn?.dispose();
      sensorProc?.dispose();
      out.dispose();
    }
  });
}

export function deactivate() {
  try { conn?.dispose(); } catch {}
  try { sensorProc?.dispose(); } catch {}
}

function logPolicy(out: vscode.OutputChannel, p: ReturnType<PolicyEngine["compute"]>) {
  const flags = Object.entries(p.health.flags || {}).filter(([,v])=>v).map(([k])=>k);
  out.appendLine(
    `[dw] policy: mode=${p.effectiveMode} ` +
    `transition=${p.isTransitioning} adapt=${p.canAdapt} ` +
    `conf=${p.confidence.toFixed(2)} health=${p.health.status}` +
    (flags.length ? ` [${flags.join(", ")}]` : "") +
    ` reason=${p.reason}`
  );
}
