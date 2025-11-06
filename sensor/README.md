# Dynamic Workspace — Sensor

Local posture sensor that powers the Dynamic Workspace extension. Uses **OpenCV** + **MediaPipe** to estimate distance proxies, fuses them, and exposes a **WebSocket** API.

- **Zero cloud**: all video processing stays on your machine.
- **Adaptive QoS**: auto scales processing to stay responsive.

## Requirements

- Python 3.10+ recommended
- OS camera permissions
- `pip install -r requirements.txt`

```
opencv-python
mediapipe
websockets
psutil
pyinstaller        # optional, for building single-file binaries
```

## Run from source

```bash
cd sensor
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\Activate.ps1
pip install -r requirements.txt
python main_sensor.py --port 8765 --camera 0 --fps 20
```

The VS Code extension’s default URL is `ws://localhost:8765`.

### Command-line flags

- `--port <int>`: WebSocket port (default `8765`)
- `--camera <int>`: Camera index (default `0`)
- `--fps <float>`: Target processing fps (default `20`)

## WebSocket protocol

Events **from** sensor:

- **State** (on change)
  ```json
  { "type":"state", "v":6, "state":"FOCUS" }  // or REVIEW / TRANSITION_TO_*
  ```
- **Heartbeat** (every 250–500ms typical)
  ```json
  {
    "type":"hb",
    "fps": 20.1,
    "metric_nose_z_x100": -43.9,
    "confidence": 0.92,
    "features": { "eye_dist": 0.14, "bbox_area": 0.15, "roll_deg": 2.1, "yaw_proxy": 0.08, "has_face": true, "has_pose": true },
    "fused": { "raw": 0.58, "ema": 0.57 },
    "health": { "status": "OK", "flags": { "low_light": false, "camera_error": false } },
    "perf": { "avg_ms": 40.8, "target_fps": 20, "proc_scale": 0.9, "fd_stride": 1, "pose_stride": 1, "cpu_pct": 22.0 },
    "transition": { "target": null, "elapsed_ms": 0, "required_ms": 0 }
  }
  ```

Commands **to** sensor (JSON):

- **Calibration**
  ```json
  { "cmd":"calibrate_phase", "phase":"REVIEW", "duration_s": 3.0 }
  { "cmd":"calibrate_phase", "phase":"FOCUS",  "duration_s": 3.0 }
  { "cmd":"calibrate_finalize" }
  ```
  Responses:
  - `{ "type":"calib_status", "phase":"REVIEW", "status":"sampling" }`
  - `{ "type":"calib_result_phase", "phase":"REVIEW", "mean":..., "std":..., "n":..., "stable": true, "face_means": {...} }`
  - `{ "type":"calib_done", "saved": { ... thresholds & face baselines ... } }`

- **Runtime tuning**
  ```json
  { "cmd":"set_conf_min", "value": 0.65 }
  { "cmd":"set_qos", "proc_scale": 0.8, "fd_stride": 2, "pose_stride": 1, "target_fps": 22 }
  ```

- **Camera discovery & switch**
  ```json
  { "cmd":"cameras" }                 // → { "type":"cameras", "list":[0,1], "current":0 }
  { "cmd":"switch_camera", "index":1 } // → { "type":"ack", "what":"switch_camera", "ok":true, "index":1 }
  ```

## Calibration storage

Calibration and face baselines are saved under an OS-specific config dir:

- Windows: `%APPDATA%\DynamicWorkspace\config\calibration.json`
- macOS: `~/Library/Application Support/DynamicWorkspace/config/calibration.json`
- Linux:  `~/.config/DynamicWorkspace/config/calibration.json`

## Building single-file binaries (PyInstaller)

> CI builds are provided in Releases, but you can build locally:

macOS / Linux:
```bash
cd sensor
./scripts/build_pyinstaller.sh
# output: sensor/dist/dw-sensor (or .exe on Windows)
```

Windows (PowerShell):
```powershell
cd sensor
python -m pip install -U pip wheel
pip install -r requirements.txt
pyinstaller -F -n dw-sensor --collect-submodules mediapipe --collect-data mediapipe --collect-submodules cv2 main_sensor.py
```

### OS notes

- **Windows**: you may need the Microsoft Visual C++ Redistributable.
- **macOS**: first run may need `xattr -d com.apple.quarantine ./dw-sensor`; allow camera in System Settings.
- **Linux**: ensure `v4l2` / UVC camera has permissions; install OpenGL libs if OpenCV complains (`libgl1` on Debian/Ubuntu).

## Health & performance

- Health flags (e.g., `low_light`, `motion_blur`, `camera_error`) are published in `hb.health`.
- QoS auto-adjusts `proc_scale`, `fd_stride`, and `pose_stride` to stay within frame budget.

## Privacy

All processing is local. No frames are saved or sent over the network.
