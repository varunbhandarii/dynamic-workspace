import * as vscode from "vscode";
import type { PolicyOutput } from "./policy";

type Mode = "FOCUS" | "REVIEW";

export class ModeApplier {
  private out: vscode.OutputChannel;
  private lastAppliedMode: Mode | null = null;
  private lastAppliedEditorUri: string | null = null;
  private lastAppliedDocVersion: number | null = null;

  private latestPolicy: PolicyOutput | null = null;
  private timer?: NodeJS.Timeout;
  private zenManaged = false;

  private foldLevel = 2;
  private zenOnReview = false;
  private affectMarkdown = false;
  private debounceMs = 250;
  private langAllowlist: string[] = [];
  private scrollPauseMs = 1200;
  private minLinesToFold = 150;

  private lastUserScrollTs = 0;
  private suppressScrollUntil = 0;
  private prevTopLine: number | undefined;

  constructor(out: vscode.OutputChannel) {
    this.out = out;
    this.readConfig();

    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration("dynamicWorkspace")) this.readConfig();
    });
  }

  schedule(policy: PolicyOutput) {
    this.latestPolicy = policy;
    if (this.timer) clearTimeout(this.timer);

    const urgent = (this.lastAppliedMode !== policy.effectiveMode);
    const now = Date.now();
    const sinceScroll = now - this.lastUserScrollTs;

    const shouldPauseForScroll = !urgent && (sinceScroll < this.scrollPauseMs);
    const extra = shouldPauseForScroll ? (this.scrollPauseMs - sinceScroll) : 0;
    const delay = urgent ? 0 : Math.max(this.debounceMs, extra);

    this.out.appendLine(
      `[dw] schedule: mode=${policy.effectiveMode} urgent=${urgent} delay=${delay}ms (sinceScroll=${sinceScroll}ms)`
    );

    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.latestPolicy) void this.apply(this.latestPolicy);
    }, delay);
  }

  editorChanged() {
    if (this.latestPolicy) this.schedule(this.latestPolicy);
  }

  noteScroll(e: vscode.TextEditorVisibleRangesChangeEvent) {
    const now = Date.now();
    if (now < this.suppressScrollUntil) return;

    const active = vscode.window.activeTextEditor;
    if (!active || e.textEditor !== active) return;

    const top = e.visibleRanges?.[0]?.start.line;
    if (top == null) return;

    const prev = this.prevTopLine ?? top;
    const delta = Math.abs(top - prev);
    this.prevTopLine = top;

    if (delta >= 3) {
      this.lastUserScrollTs = now;
      this.out.appendLine(`[dw] scroll: Δ${delta} lines (top=${top}) → pause ${this.scrollPauseMs}ms`);
    }
  }

  private readConfig() {
    const cfg = vscode.workspace.getConfiguration("dynamicWorkspace");
    this.foldLevel = clamp(cfg.get<number>("foldLevelOnReview", 2), 1, 7);
    this.zenOnReview = cfg.get<boolean>("zenModeOnReview", false);
    this.affectMarkdown = cfg.get<boolean>("affectMarkdown", false);
    this.debounceMs = clamp(cfg.get<number>("debounceMs", 250), 0, 2000);
    this.langAllowlist = cfg.get<string[]>("languageAllowlist", []) || [];
    this.scrollPauseMs = clamp(cfg.get<number>("scrollPauseMs", 1200), 0, 5000);
    this.minLinesToFold = Math.max(1, cfg.get<number>("minLinesToFold", 150));
  }

  private shouldAffectEditor(editor: vscode.TextEditor | undefined): boolean {
    if (!editor) return false;
    const id = editor.document.languageId;
    if (!this.affectMarkdown && id === "markdown") return false;
    if (this.langAllowlist.length === 0) return true;
    return this.langAllowlist.includes(id);
  }

  private alreadyAppliedFor(editor: vscode.TextEditor | undefined, mode: Mode): boolean {
    if (!editor) return false;
    const uri = editor.document.uri.toString();
    const ver = editor.document.version;
    return (
      this.lastAppliedMode === mode &&
      this.lastAppliedEditorUri === uri &&
      this.lastAppliedDocVersion === ver
    );
  }

  private rememberApplied(editor: vscode.TextEditor | undefined, mode: Mode) {
    if (!editor) return;
    this.lastAppliedMode = mode;
    this.lastAppliedEditorUri = editor.document.uri.toString();
    this.lastAppliedDocVersion = editor.document.version;
  }

  private async apply(policy: PolicyOutput) {
    const mode = policy.effectiveMode;

    if (!policy.canAdapt) {
      this.out.appendLine(`[dw] applier: canAdapt=false → skip`);
      return;
    }

    const editor = vscode.window.activeTextEditor;

    if (this.alreadyAppliedFor(editor, mode)) {
      this.out.appendLine(`[dw] applier: same editor+version and mode=${mode} → no-op`);
      return;
    }

    this.suppressScrollUntil = Date.now() + 900;

    if (mode === "FOCUS") await this.applyFocus(editor);
    else await this.applyReview(editor);

    this.rememberApplied(editor, mode);

    this.suppressScrollUntil = Date.now() + 600;
  }

  private captureAnchor(editor?: vscode.TextEditor): number | undefined {
    if (!editor) return undefined;
    const vr = editor.visibleRanges?.[0];
    if (!vr) return editor.selection?.active?.line;

    const mid = Math.floor((vr.start.line + vr.end.line) / 2);
    const sel = editor.selection?.active?.line;
    if (sel != null && sel >= vr.start.line && sel <= vr.end.line) return sel;
    return mid;
  }

  private async restoreIfMovedMuch(
    editor: vscode.TextEditor | undefined,
    anchorLine: number | undefined,
    beforeTop: number | undefined
  ) {
    if (!editor || anchorLine == null || beforeTop == null) return;
    try {
      const afterTop = editor.visibleRanges?.[0]?.start.line;
      if (afterTop == null) return;
      const delta = Math.abs(afterTop - beforeTop);
      if (delta >= 10) {
        const pos = new vscode.Position(anchorLine, 0);
        const rng = new vscode.Range(pos, pos);
        editor.revealRange(rng, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      }
    } catch { /* no-op */ }
  }

  private async setEditorConfig<K extends keyof EditorSettings>(key: K, value: EditorSettings[K]) {
    const cfg = vscode.workspace.getConfiguration("editor");
    const current = cfg.get<EditorSettings[K]>(key as string);
    if (current === value) return;
    await cfg.update(key as string, value, vscode.ConfigurationTarget.Global);
  }

  private async applyFocus(editor: vscode.TextEditor | undefined) {
    const beforeTop = editor?.visibleRanges?.[0]?.start.line;
    const anchor = this.captureAnchor(editor);

    if (this.shouldAffectEditor(editor)) {
      try { await vscode.commands.executeCommand("editor.unfoldAll"); } catch {}
    } else {
      this.out.appendLine(`[dw] FOCUS: editor gated (lang/markdown)`);
    }

    await this.setEditorConfig("wordWrap", "off");
    await this.setEditorConfig("minimap.enabled", true);
    await this.setEditorConfig("renderWhitespace", "selection");

    if (this.zenManaged && this.zenOnReview) {
      try { await vscode.commands.executeCommand("workbench.action.toggleZenMode"); } catch {}
      this.zenManaged = false;
    }

    await this.restoreIfMovedMuch(editor, anchor, beforeTop);
    this.out.appendLine(`[dw] apply: FOCUS (unfold, minimap on, wrap off${this.zenOnReview ? ", zen off" : ""})`);
  }

  private async applyReview(editor: vscode.TextEditor | undefined) {
    const beforeTop = editor?.visibleRanges?.[0]?.start.line;
    const anchor = this.captureAnchor(editor);

    if (this.shouldAffectEditor(editor)) {
      const lineCount = editor?.document.lineCount ?? 0;
      if (lineCount >= this.minLinesToFold) {
        const cmd = foldCommandFor(this.foldLevel);
        try { await vscode.commands.executeCommand(cmd); } catch {}
      } else {
        this.out.appendLine(`[dw] REVIEW: skip folding (small file: ${lineCount} < ${this.minLinesToFold})`);
      }
    } else {
      this.out.appendLine(`[dw] REVIEW: editor gated (lang/markdown)`);
    }

    await this.setEditorConfig("wordWrap", "bounded");
    await this.setEditorConfig("minimap.enabled", false);
    await this.setEditorConfig("renderWhitespace", "none");

    if (this.zenOnReview && !this.zenManaged) {
      try { await vscode.commands.executeCommand("workbench.action.toggleZenMode"); } catch {}
      this.zenManaged = true;
    }

    await this.restoreIfMovedMuch(editor, anchor, beforeTop);
    this.out.appendLine(
      `[dw] apply: REVIEW (fold L${this.foldLevel}, minimap off, wrap bounded${this.zenOnReview ? ", zen on" : ""})`
    );
  }
}

function foldCommandFor(level: number): string {
  const n = clamp(Math.round(level), 1, 7);
  return `editor.foldLevel${n}`;
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

type EditorSettings = {
  "wordWrap": "off" | "on" | "wordWrapColumn" | "bounded";
  "minimap.enabled": boolean;
  "renderWhitespace": "none" | "boundary" | "selection" | "trailing" | "all";
};
