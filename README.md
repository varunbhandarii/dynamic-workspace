# Dynamic Workspace (Posture-aware)

Adaptive developer workspace that changes your **VS Code** layout between **FOCUS** and **REVIEW** modes based on a local, privacy-preserving posture sensor (OpenCV + MediaPipe). No images or audio leave your machine.

- **Sensor** (`sensor/`): Python service (also shipped as single-file binaries) that reads your webcam, fuses pose/face signals, and serves a local WebSocket with state + telemetry. It now **self-terminates when VS Code closes** (parent-PID guard) and supports a WebSocket **`shutdown`** command.
- **VS Code extension** (`extensions/vscode/`): Connects to the sensor, tweaks editor ergonomics (folding, wrapping, minimap, Zen), shows a status bar, exposes **Calibration** and **Camera Select**, and can **auto-download & auto-start** the sensor for you (no manual Python setup required).

> Switch posture → watch VS Code adapt. Sit back (**REVIEW**): fold & summarize. Lean in (**FOCUS**): unfold & focus.

---

## How it works (high-level)

1. Sensor computes a fused “near/far” metric from:
   - Pose nose depth (world-Z),
   - Inter-eye distance & face bounding box (distance proxies),
   - Camera quality (brightness/blur) and head-orientation guards.
2. Hysteresis + dwell convert the fused signal into **FOCUS / REVIEW / TRANSITION** and send:
   - `state` messages on changes,
   - `hb` (heartbeat) messages with confidence, health and perf.
3. The VS Code extension runs a small **Policy Engine**:
   - Applies states with confidence & health gating,
   - Smooths UI changes (debounce, scroll/anchor guard),
   - Maps modes to editor settings.
4. You can calibrate your posture baselines, pick a camera, snooze/pause, or force a mode.

---

## Repository layout

```
dynamic-workspace/
├─ sensor/                      # Python sensor (OpenCV, MediaPipe)
│  ├─ main_sensor.py
│  ├─ requirements.txt
│  ├─ README.md
├─ extensions/
│  └─ vscode/                   # VS Code extension
│     ├─ src/
│     ├─ package.json
│     ├─ tsconfig.json
│     ├─ .vscodeignore
│     └─ README.md
├─ .github/
│  └─ workflows/                # CI for sensor binaries + VSIX
├─ .gitignore
├─ LICENSE
└─ README.md
```

---

## Quick start (users)

### A) Install the VS Code extension
- From Marketplace (recommended) — search **“Dynamic Workspace”**, or  
- Install a `.vsix` from Releases: **Extensions** panel → “⋯” → *Install from VSIX…*

### B) Provide the sensor (no manual Python needed)

**Recommended — automatic install & start**
1. Open **Settings → Dynamic Workspace**.
2. Enable **`Auto-Start Sensor`**.
3. Keep **`Sensor Path`** empty (the extension will prompt).
4. When prompted, click **Install** — the extension downloads the right binary to your per-user storage and starts it.  
   *Auto-updates reuse the same flow. The sensor auto-stops when VS Code closes.*

**Alternative — use an existing binary**
- Set **`Sensor Path`** to your downloaded `dynamic-workspace-sensor` (`.exe` on Windows) and enable **`Auto-Start Sensor`**.

**Advanced — run from source**
```bash
cd sensor
python -m venv .venv && source .venv/bin/activate      # Windows: .venv\Scripts\Activate.ps1
pip install -r requirements.txt
python main_sensor.py --port 8765 --camera 0
```

**Make sure** the extension’s **`Sensor Url`** matches (default `ws://localhost:8765`).

### C) Calibrate & choose camera
- **Command Palette** → *Dynamic Workspace: Calibrate…* (sit back, then lean in).
- **Command Palette** → *Dynamic Workspace: Select Camera…* (lists available indices).

**Status bar** shows **FOCUS/REVIEW**, confidence, and health; click to pause/snooze/force.

---

## Sensor lifecycle

- The extension sends `{ "cmd": "shutdown" }` on stop/deactivate.
- The sensor is launched with `--ppid <extension-host-pid>` and **exits by itself** if the parent ends (prevents orphaned processes), in addition to handling OS signals.

---

## Quick start (dev)

```bash
# 1) Sensor from source
cd sensor
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python main_sensor.py --port 8765 --camera 0

# 2) Extension in VS Code
cd ../extensions/vscode
npm ci
npm run compile
# Press F5 in VS Code to launch an Extension Development Host
```

---

## Building & releasing

GitHub Actions:
- Build **sensor binaries** (Windows/macOS/Linux) via PyInstaller,
- Build the **VSIX**,
- Attach assets to a GitHub Release when you push a tag.

Typical flow:
```bash
# bump versions, commit
git tag v0.1.0
git push origin v0.1.0
```

Outputs:
- Sensor archives (e.g., `dw-sensor-<os>-<arch>.zip`) containing the platform binary,
- `dynamic-workspace-<version>.vsix`.

---

## Extension settings (most relevant)

- `dynamicWorkspace.autoStartSensor` (boolean) — start sensor on activation.
- `dynamicWorkspace.autoDownloadSensor` (boolean) — allow the extension to fetch/update a sensor binary automatically (default **true**).
- `dynamicWorkspace.sensorPath` (string) — optional explicit path to the sensor binary.
- `dynamicWorkspace.sensorArgs` (string[]) — extra args for advanced use.
- `dynamicWorkspace.cameraIndex` (number) — default camera index (used on auto-start).
- `dynamicWorkspace.sensorUrl` (string) — default `ws://localhost:8765`.
- `dynamicWorkspace.uiConfMin` (number) — min confidence to preview transitions (default `0.5`).
- `dynamicWorkspace.heartbeatMs` (number) — staleness threshold (default `4000` ms).
- `dynamicWorkspace.foldLevelOnReview` (number) — fold depth in REVIEW (default `2`).
- `dynamicWorkspace.zenModeOnReview` (boolean) — enter Zen in REVIEW (default `false`).
- `dynamicWorkspace.affectMarkdown` (boolean) — apply transforms to Markdown (default `false`).
- `dynamicWorkspace.debounceMs` (number) — UI debounce (default `250` ms).
- `dynamicWorkspace.languageAllowlist` (string[]) — languages to affect (empty = all).
- `dynamicWorkspace.scrollPauseMs` (number) — pause after scroll (default `1200` ms).
- `dynamicWorkspace.minLinesToFold` (number) — don’t fold tiny files (default `150`).

---

## Troubleshooting

- **Disconnected** — sensor not running / wrong port → start sensor or fix `Sensor Url`.
- **Port already in use** — a previous sensor instance is running → run *Dynamic Workspace: Stop Sensor* or kill the process; ensure only one instance per port.
- **PAUSED (camera_error)** — grant camera permission or close other apps using the camera.
- **Cameras not listed** — try another index (e.g., `--camera 1`, `2`) or select via command.

---

## Privacy & security

- All processing is **local**; no frames leave your device.
- The extension only connects to your local sensor URL; nothing is uploaded.

---

## License

MIT — see `LICENSE`.
