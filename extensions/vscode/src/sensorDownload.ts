import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as https from "https";
import * as cp from "child_process";
import AdmZip from "adm-zip";

type ZipEntry = import("adm-zip").IZipEntry;

type PlatformKey = "windows-x64" | "macos-x64" | "macos-arm64" | "linux-x64";

function detectPlatform(): PlatformKey {
  const p = process.platform;
  const a = process.arch;
  if (p === "win32" && a === "x64") return "windows-x64";
  if (p === "darwin" && a === "arm64") return "macos-arm64";
  if (p === "darwin") return "macos-x64";
  return "linux-x64";
}

function assetNameFor(pk: PlatformKey): string {
  return `dw-sensor-${pk}.zip`;
}

const GH_OWNER = "varunbhandarii";
const GH_REPO = "dynamic-workspace";

function latestDownloadUrl(file: string): string {
  return `https://github.com/${GH_OWNER}/${GH_REPO}/releases/latest/download/${file}`;
}

async function download(url: string, destFile: string, out: vscode.OutputChannel): Promise<void> {
  out.appendLine(`[dw] downloading ${url}`);
  await new Promise<void>((resolve, reject) => {
    const file = fs.createWriteStream(destFile);
    https
      .get(url, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          download(res.headers.location, destFile, out).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        res.pipe(file);
        file.on("finish", () => file.close(() => resolve()));
      })
      .on("error", (err) => reject(err));
  });
}

function ensureExecBit(filepath: string, out: vscode.OutputChannel): void {
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(filepath, 0o755);
    } catch (e: any) {
      out.appendLine(`[dw] chmod failed: ${e?.message || e}`);
    }
  }
  if (process.platform === "darwin") {
    try {
      cp.spawnSync("xattr", ["-d", "com.apple.quarantine", filepath], { stdio: "ignore" });
    } catch {
      /* ignore */
    }
  }
}

function extractZipSingle(zipPath: string, targetDir: string, out: vscode.OutputChannel): string {
  const zip = new AdmZip(zipPath);
  const entries: ZipEntry[] = zip.getEntries();
  if (!entries.length) throw new Error("Zip empty");

  let best =
    entries.find((e: ZipEntry) => /dynamic-workspace-sensor(\.exe)?$/.test(e.entryName)) ||
    entries
      .slice()
      .sort((a: ZipEntry, b: ZipEntry) => (b.header.size || 0) - (a.header.size || 0))[0];

  const outPath = path.join(targetDir, path.basename(best.entryName));
  out.appendLine(`[dw] extracting ${best.entryName} -> ${outPath}`);
  zip.extractEntryTo(best, targetDir, false, true);
  return outPath;
}

export async function installOrUpdateSensor(
  ctx: vscode.ExtensionContext,
  out: vscode.OutputChannel
): Promise<string | null> {
  const pk = detectPlatform();
  const fname = assetNameFor(pk);
  const url = latestDownloadUrl(fname);

  const storageRoot = ctx.globalStorageUri.fsPath;
  const sensorDir = path.join(storageRoot, "sensor", pk);
  fs.mkdirSync(sensorDir, { recursive: true });

  const tmp = path.join(os.tmpdir(), `${fname}-${Date.now()}.zip`);
  try {
    await download(url, tmp, out);
  } catch (e: any) {
    vscode.window.showErrorMessage(`Dynamic Workspace: download failed (${e?.message || e}).`);
    return null;
  }

  let binPath: string;
  try {
    binPath = extractZipSingle(tmp, sensorDir, out);
    ensureExecBit(binPath, out);
  } catch (e: any) {
    vscode.window.showErrorMessage(`Dynamic Workspace: install failed (${e?.message || e}).`);
    return null;
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }

  out.appendLine(`[dw] sensor installed at: ${binPath}`);
  return binPath;
}
