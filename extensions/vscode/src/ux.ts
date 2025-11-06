import * as vscode from "vscode";
import type { PolicyEngine } from "./policy";
import type { PolicyOutput } from "./policy";
import type { ConnectionManager } from "./conn";
import type { ModeApplier } from "./apply";

export class UxController {
  private sb: vscode.StatusBarItem;
  private lastPolicy: PolicyOutput | undefined = undefined;

  constructor(
    private ctx: vscode.ExtensionContext,
    private policy: PolicyEngine,
    private applier: ModeApplier,
    private conn: ConnectionManager,
    private out: vscode.OutputChannel
  ) {
    this.sb = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.sb.command = "dynamicWorkspace.pauseToggle";
    this.sb.tooltip = "Dynamic Workspace: Pause/Resume";
    this.sb.show();

    this.registerCommands();
    this.render();
  }

  render(p?: PolicyOutput) {
    if (p) this.lastPolicy = p;
    const policy: PolicyOutput | undefined = p ?? this.lastPolicy;

    const text = this.makeText(policy);
    const tooltip = this.makeTooltip(policy);

    this.sb.text = text;
    this.sb.tooltip = tooltip;

    this.sb.backgroundColor = undefined;
    const hs = policy?.health.status;
    if (hs === "PAUSED") {
      this.sb.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
    } else if (hs === "DEGRADED") {
      this.sb.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    }
  }

  private registerCommands() {
    this.ctx.subscriptions.push(
      vscode.commands.registerCommand("dynamicWorkspace.pauseToggle", async () => {
        const nowPolicy = this.policy.compute();
        const isPaused = !nowPolicy.canAdapt;
        this.policy.setOverride({ paused: !isPaused, snoozeUntil: 0, forceMode: null });
        const p = this.policy.compute();
        this.applier.schedule(p);
        this.render(p);
        this.out.appendLine(`[dw] cmd: pauseToggle → ${!isPaused ? "PAUSED" : "RESUMED"}`);
      }),

      vscode.commands.registerCommand("dynamicWorkspace.snooze", async () => {
        const pick = await vscode.window.showQuickPick(
          [
            { label: "5 minutes", val: 5 },
            { label: "15 minutes", val: 15 },
            { label: "30 minutes", val: 30 },
            { label: "1 hour", val: 60 },
            { label: "Clear Snooze", val: 0 }
          ],
          { placeHolder: "Temporarily pause adaptation" }
        );
        if (!pick) return;
        const until = pick.val > 0 ? Date.now() + pick.val * 60_000 : 0;
        this.policy.setOverride({ snoozeUntil: until, paused: false, forceMode: null });
        const p = this.policy.compute();
        this.applier.schedule(p);
        this.render(p);
        this.out.appendLine(`[dw] cmd: snooze → ${pick.label}`);
      }),

      vscode.commands.registerCommand("dynamicWorkspace.forceFocus", async () => {
        this.policy.setOverride({ forceMode: "FOCUS", paused: false, snoozeUntil: 0 });
        const p = this.policy.compute();
        this.applier.schedule(p);
        this.render(p);
        this.out.appendLine(`[dw] cmd: force → FOCUS`);
      }),

      vscode.commands.registerCommand("dynamicWorkspace.forceReview", async () => {
        this.policy.setOverride({ forceMode: "REVIEW", paused: false, snoozeUntil: 0 });
        const p = this.policy.compute();
        this.applier.schedule(p);
        this.render(p);
        this.out.appendLine(`[dw] cmd: force → REVIEW`);
      }),

      vscode.commands.registerCommand("dynamicWorkspace.clearOverride", async () => {
        this.policy.clearOverride();
        const p = this.policy.compute();
        this.applier.schedule(p);
        this.render(p);
        this.out.appendLine(`[dw] cmd: clearOverride`);
      }),

      vscode.commands.registerCommand("dynamicWorkspace.reconnect", async () => {
        this.conn.restart();
        vscode.window.showInformationMessage("Dynamic Workspace: reconnecting to sensor…");
      }),

      vscode.commands.registerCommand("dynamicWorkspace.openSettings", async () => {
        await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:dynamic-workspace");
      })
    );
  }

  private makeText(p?: PolicyOutput) {
    if (!p) return `DW $(watch)`;
    const mode = p.effectiveMode;
    const hs = p.health.status || "OK";
    const paused = !p.canAdapt;
    const icon = paused ? "$(debug-pause)" : (mode === "FOCUS" ? "$(eye)" : "$(preview)");
    const healthTag = hs === "OK" ? "" : `·${hs}`;
    return `DW ${icon} ${mode}${healthTag}`;
  }

  private makeTooltip(p?: PolicyOutput) {
    if (!p) return "Dynamic Workspace";
    const lines = [
      `Mode: ${p.effectiveMode}${p.isTransitioning ? " (transitioning)" : ""}`,
      `Confidence: ${p.confidence.toFixed(2)}`,
      `Health: ${p.health.status}`,
      `Reason: ${p.reason}`,
      "",
      "Click to Pause/Resume",
      "Right-click → Commands (Snooze, Force, Reconnect, Settings)"
    ];
    return lines.join("\n");
  }
}
