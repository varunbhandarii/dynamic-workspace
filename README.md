# Dynamic Workspace (Posture-aware)

Adaptive developer workspace that changes your **VS Code** layout between **FOCUS** and **REVIEW** modes based on a local, privacy-preserving posture sensor (OpenCV + MediaPipe). No images or audio leave your machine.

- **Sensor** (`sensor/`): Python service that reads your webcam, fuses pose/face signals, and streams a local WebSocket with state + telemetry.
- **VS Code extension** (`extensions/vscode/`): Connects to the sensor, tweaks editor ergonomics (folding, wrapping, minimap, Zen), shows a status bar, exposes **Calibration** and **Camera Select**, and can **auto-start** the sensor binary for you.

> ✨ Switch posture → watch VS Code adapt. Sit back (REVIEW): fold & summarize; lean in (FOCUS): unfold & focus.

---

## How it works (high-level)

1. Sensor computes a fused “near/far” metric from:
   - Pose nose depth (world-Z),
   - Inter-eye distance & face bounding box (as distance proxies),
   - Basic camera quality (brightness/blur) and head orientation guards.
2. Hysteresis + dwell convert the fused signal into **FOCUS / REVIEW / TRANSITION** states and send:
   - `state` messages on changes,
   - `hb` (heartbeat) messages with confidence, health and perf.
3. The VS Code extension runs a small **Policy Engine**:
   - Applies states with confidence & health gating,
   - Smoothes UI changes (debounce, scroll/anchor guard),
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

- From Marketplace (recommended) — search **“Dynamic Workspace (Posture-aware)”**, or  
- Install a `.vsix` from Releases: **Extensions** panel → “⋯” → *Install from VSIX…*

### B) Provide the sensor

Pick **one** of three options:

1) **Auto-start (built binary)**  
Open **Settings → Dynamic Workspace**:
- ✅ `Dynamic Workspace › Auto-Start Sensor: Enabled`
- `Dynamic Workspace › Auto-Start Sensor: Path`: point to your downloaded `dw-sensor` (`.exe` on Windows).  
  (See Releases for prebuilt binaries; or build your own below.)

2) **Run from source**
```bash
cd sensor
python -m venv .venv && source .venv/bin/activate      # Windows: .venv\Scripts\Activate.ps1
pip install -r requirements.txt
python main_sensor.py --port 8765 --camera 0
```

3) **Already running**  
If you run the sensor yourself, ensure the extension setting `Sensor Url` matches (default `ws://localhost:8765`).

### C) Calibrate & choose camera
- **Command Palette** → *Dynamic Workspace: Calibrate…* (two short steps: sit back, lean in).
- **Command Palette** → *Dynamic Workspace: Select Camera…* (shows detected indices).  
  You can also pass `--camera N` when starting the sensor.

That’s it. The status bar shows **FOCUS/REVIEW**, confidence, and health; click it to pause/snooze/force.

---

## Quick start

Run both components in dev mode:

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

This repo includes GitHub Actions that:

- Build **sensor binaries** for Windows/macOS/Linux via PyInstaller,
- Build the **VSIX** package,
- Attach assets to a GitHub Release when you push a tag.

Typical flow:

```bash
# bump versions, commit
git tag v0.1.0
git push origin v0.1.0
```

Actions produce:
- `sensor-<OS>-<arch>.zip` (containing `dw-sensor`),
- `dynamic-workspace-<version>.vsix`.

---

## Extension settings (high-value)

- `dynamicWorkspace.autoStartSensorEnabled` (boolean): run sensor on activation.
- `dynamicWorkspace.autoStartSensorPath` (string): path to sensor binary (`dw-sensor`).
- `dynamicWorkspace.sensorUrl`: default `ws://localhost:8765`.
- `dynamicWorkspace.uiConfMin`: min confidence to preview transitions (default `0.5`).
- `dynamicWorkspace.heartbeatMs`: staleness threshold (default `4000`).
- `dynamicWorkspace.foldLevelOnReview`: fold depth (default `2`).
- `dynamicWorkspace.zenModeOnReview`: enter Zen in REVIEW (default `false`).
- `dynamicWorkspace.affectMarkdown`: apply transforms to Markdown (default `false`).
- `dynamicWorkspace.debounceMs`: UI debounce (default `250`).
- `dynamicWorkspace.languageAllowlist`: languages to affect (empty = all).
- `dynamicWorkspace.scrollPauseMs`: pause after user scrolls (default `1200` ms).
- `dynamicWorkspace.minLinesToFold`: don’t fold tiny files (default `150`).

---

## Troubleshooting

- **“Disconnected”**: sensor not running / wrong port → start sensor or fix `Sensor Url`.
- **“PAUSED (camera_error)”**: OS permission or camera busy → allow camera access or close other apps.
- **No cameras listed**: Linux may map cameras to different indices; try `--camera 1`, `2`, etc.
- **macOS security**: first run may need `xattr -d com.apple.quarantine ./dw-sensor` and permission prompts.

---

## Privacy & security

- All processing is **local**; no frames leave your device.
- The extension only connects to your local sensor URL; nothing is uploaded.

---

---

## License

MIT. See `LICENSE`.
