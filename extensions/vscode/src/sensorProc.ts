import * as vscode from "vscode";
import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import * as fs from "fs";
import { installOrUpdateSensor } from "./sensorDownload";

function parsePortFromWsUrl(url: string): number {
  try {
    const u = new URL(url);
    if (!u.port) return 8765;
    return Number(u.port) || 8765;
  } catch {
    return 8765;
  }
}

export class SensorProcessManager {
  private proc: ChildProcessWithoutNullStreams | null = null;
  constructor(private out: vscode.OutputChannel) {}

  async startFromConfig(ctx?: vscode.ExtensionContext): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("dynamicWorkspace");
    const auto = !!cfg.get<boolean>("autoStartSensor", false);
    if (!auto) return;

    let bin = (cfg.get<string>("sensorPath") || "").trim();
    const url = (cfg.get<string>("sensorUrl") || "ws://localhost:8765").trim();
    const cam = Number(cfg.get<number>("cameraIndex", 0));
    const extra = cfg.get<string[]>("sensorArgs", []) || [];
    const autoDl = !!cfg.get<boolean>("autoDownloadSensor", true);

    if ((!bin || !fs.existsSync(bin)) && autoDl) {
      if (!ctx) {
        this.out.appendLine("[dw] autoDownloadSensor=true but no ExtensionContext provided.");
      } else {
        const ok = await vscode.window.showInformationMessage(
          "Dynamic Workspace needs the sensor for your platform. Install now?",
          { modal: true },
          "Install"
        );
        if (ok === "Install") {
          const installed = await installOrUpdateSensor(ctx, this.out);
          if (installed) {
            await cfg.update("sensorPath", installed, vscode.ConfigurationTarget.Global);
            bin = installed;
          }
        }
      }
    }

    if (!bin) {
      this.out.appendLine("[dw] autoStartSensor=true but sensorPath is empty.");
      return;
    }
    if (!fs.existsSync(bin)) {
      this.out.appendLine(`[dw] sensorPath not found: ${bin}`);
      vscode.window.showWarningMessage("Dynamic Workspace: sensorPath not found. Check settings.");
      return;
    }

    const port = parsePortFromWsUrl(url);
    const args = ["--port", String(port), "--camera", String(cam), ...extra];

    this.out.appendLine(`[dw] starting sensor: "${bin}" ${args.join(" ")}`);
    try {
      this.proc = spawn(bin, args, { windowsHide: true });

      this.proc.stdout.on("data", d => this.out.appendLine(`[sensor] ${String(d).trimEnd()}`));
      this.proc.stderr.on("data", d => this.out.appendLine(`[sensor:err] ${String(d).trimEnd()}`));
      this.proc.on("close", code => {
        this.out.appendLine(`[dw] sensor exited with code ${code}`);
        this.proc = null;
      });
      this.proc.on("error", err => {
        this.out.appendLine(`[dw] sensor spawn error: ${err?.message || err}`);
        this.proc = null;
      });
    } catch (e: any) {
      this.out.appendLine(`[dw] failed to spawn sensor: ${e?.message || e}`);
      this.proc = null;
    }
  }

  stop(): void {
    if (!this.proc) return;
    try {
      this.out.appendLine("[dw] stopping sensor…");
      if (process.platform === "win32") {
        this.proc.kill();
      } else {
        this.proc.kill("SIGTERM");
      }
    } catch {}
    this.proc = null;
  }

  async restart(ctx?: vscode.ExtensionContext): Promise<void> {
    this.stop();
    await this.startFromConfig(ctx);
  }

  dispose(): void {
    this.stop();
  }
}
