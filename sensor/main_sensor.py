import cv2
import mediapipe as mp
import time
import asyncio
import websockets
import json
import threading
import os
import math
from datetime import datetime
import concurrent.futures

try:
    import psutil
except Exception:
    psutil = None

import argparse

import sys
from pathlib import Path

def user_config_dir(app="DynamicWorkspace", author="VarunBhandari"):
    if sys.platform == "win32":
        base = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
        return os.path.join(base, app)
    elif sys.platform == "darwin":
        base = str(Path.home() / "Library" / "Application Support")
        return os.path.join(base, app)
    else:
        base = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
        return os.path.join(base, app)

CONFIG_DIR = os.path.join(user_config_dir(), "config")
CALIB_PATH = os.path.join(CONFIG_DIR, "calibration.json")


STATE_FOCUS = "FOCUS"
STATE_REVIEW = "REVIEW"
STATE_TRANSITION_TO_FOCUS = "TRANSITION_TO_FOCUS"
STATE_TRANSITION_TO_REVIEW = "TRANSITION_TO_REVIEW"

USE_FUSED_FOR_STATE = True
EMA_TAU_S  = 0.25
WINSOR_DELTA = 0.35
W_Z_BASE, W_EYE_BASE, W_BBOX_BASE = 0.6, 0.3, 0.1
FUSED_T_REVIEW_IN, FUSED_T_FOCUS_IN = 0.40, 0.60
FUSED_DWELL_REVIEW_MS, FUSED_DWELL_FOCUS_MS = 750, 750
MIN_FLIP_GAP_MS = 1500

g_cam_index = 0
g_cam_switch_request = None

CONF_MIN = 0.65
BRIGHTNESS_MIN = 60.0
BRIGHTNESS_GOOD = 120.0
BLUR_MIN = 60.0
BLUR_GOOD = 150.0
MAX_ABS_YAW = 0.55
MAX_ABS_ROLL_DEG = 30.0
FACE_LOST_FRAMES = 10
POSE_LOST_FRAMES = 10

DEFAULT_TIME_THRESHOLD = 0.75
DEFAULT_THRESHOLD_Z = -29.5

TARGET_FPS = 20.0
FRAME_BUDGET_MS = 1000.0 / TARGET_FPS
PROC_SCALE_MIN, PROC_SCALE_MAX = 0.55, 0.90
FD_STRIDE_MIN,  FD_STRIDE_MAX  = 1, 4
POSE_STRIDE_MIN,POSE_STRIDE_MAX= 1, 3
HB_BASE_HZ, HB_LOW_HZ = 4.0, 2.0
OVERLOAD_HIGH = 1.10
OVERLOAD_CLEAR = 0.85
CPU_OVERLOAD = 85.0
QoS_ADJUST_PERIOD = 1.0
ROLLING_NSAMPLES = 30

cv2.setUseOptimized(True)

g_state_lock = threading.Lock()
g_current_state = STATE_FOCUS

g_metric_lock = threading.Lock()
g_latest_metric = None
g_latest_confidence = 0.0

g_feat_lock = threading.Lock()
g_features = {
    "bbox_area": None, "eye_dist": None, "roll_deg": None, "yaw_proxy": None,
    "face_score": 0.0, "has_face": False, "eyes_visible": False, "ears_visible": False,
    "has_pose": False
}

g_fused_lock = threading.Lock()
g_fused_raw = None
g_fused_ema = None
g_last_ts = None

g_fps = 0.0

g_thresholds = {"mid": DEFAULT_THRESHOLD_Z, "t_focus_in": DEFAULT_THRESHOLD_Z-1.0,
                "t_review_in": DEFAULT_THRESHOLD_Z+1.0, "dwell_ms": int(DEFAULT_TIME_THRESHOLD*1000)}
g_face_calib = { "review": {"eye_dist": None, "bbox_area": None},
                 "focus":  {"eye_dist": None, "bbox_area": None} }

g_last_stable_change_ts = 0.0
g_transition_target = None
g_transition_start_ts = 0.0

g_health_lock = threading.Lock()
g_health = {
    "status": "OK",
    "flags": {
        "low_light": False,
        "motion_blur": False,
        "face_lost": False,
        "pose_lost": False,
        "looking_away": False,
        "too_close_far": False,
        "camera_error": False
    },
    "brightness": None,
    "blur_var": None
}
_face_lost_streak = 0
_pose_lost_streak = 0

g_qos_lock = threading.Lock()
g_qos = {
    "proc_scale": 0.75,
    "fd_stride": 2,
    "pose_stride": 2,
    "avg_ms": FRAME_BUDGET_MS,
    "overload": False,
    "hb_interval": 1.0 / HB_BASE_HZ,
    "cam_res": (0, 0),
    "proc_res": (0, 0),
    "cpu_pct": None
}
_frame_times = []
_last_qos_adjust = 0

def ensure_config_dir():
    try: os.makedirs(CONFIG_DIR, exist_ok=True)
    except Exception: pass

def load_calibration():
    ensure_config_dir()
    if not os.path.exists(CALIB_PATH):
        print("[calib] No calibration file; using defaults.")
        return None
    try:
        with open(CALIB_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        thr = data.get("thresholds", {})
        g_thresholds["mid"] = float(thr.get("mid", g_thresholds["mid"]))
        g_thresholds["t_focus_in"] = float(thr.get("t_focus_in", g_thresholds["t_focus_in"]))
        g_thresholds["t_review_in"] = float(thr.get("t_review_in", g_thresholds["t_review_in"]))
        g_thresholds["dwell_ms"] = int(thr.get("dwell_ms", g_thresholds["dwell_ms"]))
        fb = data.get("face_baselines", {})
        rv, fc = fb.get("review", {}), fb.get("focus", {})
        g_face_calib["review"]["eye_dist"] = rv.get("eye_dist")
        g_face_calib["review"]["bbox_area"] = rv.get("bbox_area")
        g_face_calib["focus"]["eye_dist"]  = fc.get("eye_dist")
        g_face_calib["focus"]["bbox_area"] = fc.get("bbox_area")
        print(f"[calib] Loaded thresholds: {g_thresholds}")
        print(f"[calib] Face baselines: {g_face_calib}")
        return data
    except Exception as e:
        print(f"[calib] Failed to load: {e}")
        return None

def save_calibration(review_mean, review_std, focus_mean, focus_std,
                     dwell_ms=750, face_review=None, face_focus=None):
    ensure_config_dir()
    mid = (review_mean + focus_mean) / 2.0
    gap = abs(review_mean - focus_mean)
    band = max(0.8, min(3.0, 0.2 * gap))
    t_focus_in = mid - band/2.0
    t_review_in = mid + band/2.0
    fb = { "review": {"eye_dist": None, "bbox_area": None},
           "focus":  {"eye_dist": None, "bbox_area": None} }
    if face_review:
        fb["review"]["eye_dist"] = face_review.get("eye_dist")
        fb["review"]["bbox_area"] = face_review.get("bbox_area")
    if face_focus:
        fb["focus"]["eye_dist"] = face_focus.get("eye_dist")
        fb["focus"]["bbox_area"] = face_focus.get("bbox_area")
    data = {
        "v": 2,
        "metric": "nose_world_z_x100",
        "review_mean": review_mean, "review_std": review_std,
        "focus_mean":  focus_mean,  "focus_std":  focus_std,
        "thresholds": {
            "mid": mid, "t_focus_in": t_focus_in, "t_review_in": t_review_in, "dwell_ms": dwell_ms
        },
        "face_baselines": fb,
        "created_at": datetime.utcnow().isoformat() + "Z"
    }
    with open(CALIB_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    g_thresholds.update({"mid": mid, "t_focus_in": t_focus_in, "t_review_in": t_review_in, "dwell_ms": dwell_ms})
    g_face_calib.update(fb)
    print(f"[calib] Saved: {data}")
    return data

def _safe_kp(rel_kps, idx):
    try:
        kp = rel_kps[idx]
        return kp.x, kp.y
    except Exception:
        return None, None

def compute_face_features(image_w, image_h, detection, mp_fd):
    feats = {
        "bbox_area": None, "eye_dist": None, "roll_deg": None, "yaw_proxy": None,
        "face_score": 0.0, "eyes_visible": False, "ears_visible": False
    }
    if detection is None: return feats
    try:
        score = float(detection.score[0]) if detection.score else 0.0
    except Exception:
        score = 0.0
    feats["face_score"] = score
    try:
        bbox = detection.location_data.relative_bounding_box
        w = max(0.0, min(1.0, bbox.width))
        h = max(0.0, min(1.0, bbox.height))
        feats["bbox_area"] = w * h
    except Exception:
        pass
    rel_kps = getattr(detection.location_data, "relative_keypoints", None)
    if rel_kps and len(rel_kps) >= 6:
        rx, ry = _safe_kp(rel_kps, mp_fd.FaceKeyPoint.RIGHT_EYE)
        lx, ly = _safe_kp(rel_kps, mp_fd.FaceKeyPoint.LEFT_EYE)
        nx, ny = _safe_kp(rel_kps, mp_fd.FaceKeyPoint.NOSE_TIP)
        rtx, rty = _safe_kp(rel_kps, mp_fd.FaceKeyPoint.RIGHT_EAR_TRAGION)
        ltx, lty = _safe_kp(rel_kps, mp_fd.FaceKeyPoint.LEFT_EAR_TRAGION)
        if rx is not None and lx is not None:
            right = (rx, ry); left = (lx, ly)
            if left[0] > right[0]:
                left, right = right, left

            dx = (right[0] - left[0])
            dy = (right[1] - left[1])

            feats["eye_dist"] = math.hypot(dx, dy)
            feats["eyes_visible"] = True

            ang = math.degrees(math.atan2(dy, dx))
            if ang < -90.0:
                ang += 180.0
            elif ang > 90.0:
                ang -= 180.0

            feats["roll_deg"] = ang
            feats["roll_mag_deg"] = abs(ang)
        if (rtx is not None and ltx is not None) and (nx is not None):
            d_right = math.hypot((rtx - nx), (rty - ny))
            d_left  = math.hypot((ltx - nx), (lty - ny))
            eps = 1e-6
            feats["yaw_proxy"] = math.log((d_right + eps) / (d_left + eps))
            feats["ears_visible"] = True
    return feats

def clamp01(x):
    return 0.0 if x is None else (1.0 if x > 1.0 else (0.0 if x < 0.0 else x))

def lin_norm_near1(x, far_mean, near_mean):
    if x is None or far_mean is None or near_mean is None or near_mean == far_mean:
        return None
    t = (x - far_mean) / (near_mean - far_mean)
    return clamp01(t)

def fuse_components(z_norm, eye_norm, bbox_norm, has_pose, eyes_visible, has_face, face_score):
    wz, weye, wb = W_Z_BASE, W_EYE_BASE, W_BBOX_BASE
    wz   = wz   if has_pose else 0.0
    weye = weye if eyes_visible else 0.0
    wb   = wb   if has_face else 0.0
    fs = max(0.0, min(1.0, face_score))
    weye *= fs; wb *= fs
    if z_norm   is None: wz   = 0.0
    if eye_norm is None: weye = 0.0
    if bbox_norm is None: wb  = 0.0
    wsum = wz + weye + wb
    if wsum <= 0.0:
        return None, {"wz":0,"weye":0,"wb":0}
    z = (z_norm or 0.0); e = (eye_norm or 0.0); b = (bbox_norm or 0.0)
    fused = (wz*z + weye*e + wb*b) / wsum
    return clamp01(fused), {"wz":wz/wsum, "weye":weye/wsum, "wb":wb/wsum}

def ema_update(prev, x, dt):
    if x is None: return prev
    if prev is None: return x
    beta = 1.0 - math.exp(-max(dt, 1e-3) / EMA_TAU_S)
    x_clamped = max(prev - WINSOR_DELTA, min(prev + WINSOR_DELTA, x))
    return prev + beta * (x_clamped - prev)

def measure_brightness_blur(bgr_small):
    gray = cv2.cvtColor(bgr_small, cv2.COLOR_BGR2GRAY)
    mean = float(cv2.mean(gray)[0])
    lap = cv2.Laplacian(gray, cv2.CV_64F)
    var = float(lap.var())
    return mean, var

def norm_quality(val, vmin, vgood):
    if val is None: return 0.0
    if val <= vmin: return 0.0
    if val >= vgood: return 1.0
    return (val - vmin) / (vgood - vmin)

def run_pose_detection():
    global g_current_state, g_latest_metric, g_latest_confidence, g_fps
    global g_fused_raw, g_fused_ema, g_last_ts
    global g_last_stable_change_ts, g_transition_target, g_transition_start_ts
    global _face_lost_streak, _pose_lost_streak, _frame_times, _last_qos_adjust

    mp_pose = mp.solutions.pose
    mp_fd = mp.solutions.face_detection
    pose = mp_pose.Pose(min_detection_confidence=0.5, min_tracking_confidence=0.5)
    face = mp_fd.FaceDetection(model_selection=0, min_detection_confidence=0.5)

    current_cam = int(g_cam_index)
    cap = cv2.VideoCapture(current_cam)
    try: cap.set(cv2.CAP_PROP_FPS, TARGET_FPS)
    except Exception: pass

    if not cap.isOpened():
        with g_health_lock:
            g_health["status"] = "PAUSED"
            g_health["flags"]["camera_error"] = True
        print("[sensor] Error: Cannot open webcam.")
        return

    cam_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)) or 0
    cam_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or 0
    with g_qos_lock:
        g_qos["cam_res"] = (cam_w, cam_h)

    print("[sensor] Pose+Face thread started...")
    last_ts_fps = time.time()
    frames = 0
    g_last_ts = time.time()

    fd_frame_counter = 0
    pose_frame_counter = 0

    def get_qos():
        with g_qos_lock:
            return (g_qos["proc_scale"], g_qos["fd_stride"], g_qos["pose_stride"])

    while cap.isOpened():
        frame_start = time.time()
        success, image = cap.read()
        if not success:
            with g_health_lock:
                g_health["flags"]["camera_error"] = True
                g_health["status"] = "PAUSED"
            time.sleep(0.02)
            continue
        else:
            with g_health_lock:
                g_health["flags"]["camera_error"] = False

        proc_scale, fd_stride, pose_stride = get_qos()

        if proc_scale < 0.999:
            proc_w = int(cam_w * proc_scale)
            proc_h = int(cam_h * proc_scale)
            proc_w = max(320, proc_w)
            proc_h = max(240, proc_h)
            image_proc = cv2.resize(image, (proc_w, proc_h), interpolation=cv2.INTER_AREA)
        else:
            image_proc = image
            proc_w, proc_h = cam_w, cam_h

        with g_qos_lock:
            g_qos["proc_res"] = (proc_w, proc_h)

        brightness, blur_var = measure_brightness_blur(image_proc)
        with g_health_lock:
            g_health["brightness"] = round(brightness, 1)
            g_health["blur_var"] = round(blur_var, 1)
        low_light = brightness < BRIGHTNESS_MIN
        motion_blur = blur_var < BLUR_MIN

        image_rgb = cv2.cvtColor(image_proc, cv2.COLOR_BGR2RGB)
        image_rgb.flags.writeable = False

        fd_run = (fd_frame_counter % fd_stride == 0)
        fd_frame_counter += 1
        mp_fd_mod = mp.solutions.face_detection
        if fd_run:
            fd_res = face.process(image_rgb)
            best_det = None
            if fd_res and fd_res.detections:
                best_det = max(fd_res.detections, key=lambda d: (d.score[0] if d.score else 0.0))
                feats = compute_face_features(proc_w, proc_h, best_det, mp_fd_mod)
                _face_lost_streak = 0
            else:
                feats = {}
                _face_lost_streak += 1
        else:
            with g_feat_lock:
                feats = dict(g_features)

        pose_run = (pose_frame_counter % pose_stride == 0)
        pose_frame_counter += 1
        metric = None; confidence = 0.0; has_pose = False
        if pose_run:
            results = pose.process(image_rgb)
            try:
                landmarks = results.pose_world_landmarks.landmark
                nose_z = landmarks[mp_pose.PoseLandmark.NOSE.value].z * 100.0
                metric = float(nose_z); confidence = 1.0; has_pose = True
                _pose_lost_streak = 0
            except Exception:
                _pose_lost_streak += 1
        else:
            with g_metric_lock:
                metric = g_latest_metric
                confidence = g_latest_confidence
            with g_feat_lock:
                has_pose = bool(g_features.get("has_pose"))

        if "has_face" not in feats:
            with g_feat_lock:
                prev = dict(g_features)
            feats = prev if feats == {} else feats
        feats["has_face"] = feats.get("has_face", feats.get("face_score", 0.0) > 0.0)
        feats["has_pose"] = has_pose
        with g_feat_lock:
            g_features.update(feats)

        with g_metric_lock:
            g_latest_metric = metric
            g_latest_confidence = confidence

        review_mean = load_calibration_cache.get("review_mean") if load_calibration_cache else None
        focus_mean  = load_calibration_cache.get("focus_mean")  if load_calibration_cache else None
        z_norm = lin_norm_near1(metric, review_mean, focus_mean)

        eye_far  = g_face_calib["review"]["eye_dist"]; eye_near  = g_face_calib["focus"]["eye_dist"]
        bbox_far = g_face_calib["review"]["bbox_area"]; bbox_near = g_face_calib["focus"]["bbox_area"]
        eye_norm  = lin_norm_near1(g_features.get("eye_dist"),  eye_far,  eye_near)
        bbox_norm = lin_norm_near1(g_features.get("bbox_area"), bbox_far, bbox_near)

        fused_raw, _w = fuse_components(
            z_norm, eye_norm, bbox_norm,
            has_pose=has_pose,
            eyes_visible=g_features.get("eyes_visible", False),
            has_face=g_features.get("has_face", False),
            face_score=g_features.get("face_score", 0.0)
        )
        now = time.time()
        dt = now - (g_last_ts if g_last_ts else now)
        g_last_ts = now
        fused_ema = ema_update(g_fused_ema, fused_raw, dt)
        with g_fused_lock:
            g_fused_raw = fused_raw
            g_fused_ema = fused_ema

        c_z   = 1.0 if (has_pose and z_norm is not None) else 0.0
        fs = max(0.0, min(1.0, g_features.get("face_score") or 0.0))
        c_eye = fs if (g_features.get("eyes_visible") and eye_norm is not None) else 0.0
        c_box = fs if (g_features.get("has_face") and bbox_norm is not None) else 0.0
        c_bri = norm_quality(brightness, BRIGHTNESS_MIN, BRIGHTNESS_GOOD)
        c_blr = norm_quality(blur_var,  BLUR_MIN,       BLUR_GOOD)
        c_q   = min(c_bri, c_blr)
        overall_conf = 0.4*c_z + 0.3*c_eye + 0.2*c_box + 0.1*c_q

        roll_mag = abs(g_features.get("roll_mag_deg")
                    if g_features.get("roll_mag_deg") is not None
                    else (g_features.get("roll_deg") or 0.0))
        yaw_val = abs(g_features.get("yaw_proxy") or 0.0)

        looking_away = (yaw_val > MAX_ABS_YAW) or (roll_mag > MAX_ABS_ROLL_DEG)
        face_lost = (_face_lost_streak >= FACE_LOST_FRAMES)
        pose_lost = (_pose_lost_streak >= POSE_LOST_FRAMES)
        too_close_far = False
        if eye_far and eye_near and g_features.get("eye_dist") is not None:
            ed = g_features["eye_dist"]
            if ed > (eye_near * 1.3) or ed < (eye_far * 0.7):
                too_close_far = True

        with g_health_lock:
            flags = g_health["flags"]
            flags["low_light"]   = low_light
            flags["motion_blur"] = motion_blur
            flags["face_lost"]   = face_lost
            flags["pose_lost"]   = pose_lost
            flags["looking_away"]= looking_away
            flags["too_close_far"]= too_close_far
            paused = face_lost or (low_light and c_bri == 0.0) or flags.get("camera_error", False)
            degraded = motion_blur or looking_away or pose_lost or too_close_far
            g_health["status"] = "PAUSED" if paused else ("DEGRADED" if degraded else "OK")

        with g_state_lock:
            current_state = g_current_state
        new_state = current_state

        with g_health_lock:
            paused_now = (g_health["status"] == "PAUSED")

        m = g_fused_ema if USE_FUSED_FOR_STATE else None
        low, high = FUSED_T_REVIEW_IN, FUSED_T_FOCUS_IN
        since_flip_ms = (now - g_last_stable_change_ts) * 1000.0

        if m is not None and not paused_now:
            confident = (overall_conf >= CONF_MIN)

            if current_state == STATE_FOCUS:
                if m <= low and since_flip_ms >= MIN_FLIP_GAP_MS and confident:
                    if g_transition_target != "REVIEW":
                        g_transition_target = "REVIEW"; g_transition_start_ts = now
                        new_state = STATE_TRANSITION_TO_REVIEW
                    else:
                        if ((now - g_transition_start_ts)*1000.0 >= FUSED_DWELL_REVIEW_MS) and confident:
                            new_state = STATE_REVIEW; g_transition_target = None; g_last_stable_change_ts = now
                else:
                    if g_transition_target == "REVIEW" and ((m > low) or (not confident)):
                        g_transition_target = None; new_state = STATE_FOCUS

            elif current_state == STATE_REVIEW:
                if m >= high and since_flip_ms >= MIN_FLIP_GAP_MS and confident:
                    if g_transition_target != "FOCUS":
                        g_transition_target = "FOCUS"; g_transition_start_ts = now
                        new_state = STATE_TRANSITION_TO_FOCUS
                    else:
                        if ((now - g_transition_start_ts)*1000.0 >= FUSED_DWELL_FOCUS_MS) and confident:
                            new_state = STATE_FOCUS; g_transition_target = None; g_last_stable_change_ts = now
                else:
                    if g_transition_target == "FOCUS" and ((m < high) or (not confident)):
                        g_transition_target = None; new_state = STATE_REVIEW

            elif current_state == STATE_TRANSITION_TO_REVIEW:
                if m > low or (overall_conf < CONF_MIN):
                    g_transition_target = None; new_state = STATE_FOCUS
                elif (now - g_transition_start_ts)*1000.0 >= FUSED_DWELL_REVIEW_MS:
                    new_state = STATE_REVIEW; g_transition_target = None; g_last_stable_change_ts = now

            elif current_state == STATE_TRANSITION_TO_FOCUS:
                if m < high or (overall_conf < CONF_MIN):
                    g_transition_target = None; new_state = STATE_REVIEW
                elif (now - g_transition_start_ts)*1000.0 >= FUSED_DWELL_FOCUS_MS:
                    new_state = STATE_FOCUS; g_transition_target = None; g_last_stable_change_ts = now

        if new_state != current_state:
            with g_state_lock:
                g_current_state = new_state
            print(f"[sensor] State changed → {new_state} (conf={overall_conf:.2f})")

        frame_end = time.time()
        frame_ms = (frame_end - frame_start) * 1000.0
        _frame_times.append(frame_ms)
        if len(_frame_times) > ROLLING_NSAMPLES:
            _frame_times.pop(0)
        avg_ms = sum(_frame_times) / max(1, len(_frame_times))
        overload = (avg_ms > FRAME_BUDGET_MS * OVERLOAD_HIGH)

        cpu_pct = None
        if psutil:
            try:
                cpu_pct = psutil.cpu_percent(interval=None)
            except Exception:
                cpu_pct = None

        now_t = frame_end
        if (now_t - _last_qos_adjust) >= QoS_ADJUST_PERIOD:
            _last_qos_adjust = now_t
            with g_qos_lock:
                g_qos["avg_ms"] = avg_ms
                g_qos["overload"] = overload
                g_qos["cpu_pct"] = cpu_pct

                g_qos["hb_interval"] = (1.0 / HB_LOW_HZ) if overload else (1.0 / HB_BASE_HZ)

                if overload or (cpu_pct is not None and cpu_pct >= CPU_OVERLOAD):
                    if g_qos["pose_stride"] < POSE_STRIDE_MAX:
                        g_qos["pose_stride"] += 1
                    elif g_qos["fd_stride"] < FD_STRIDE_MAX:
                        g_qos["fd_stride"] += 1
                    elif g_qos["proc_scale"] > PROC_SCALE_MIN:
                        g_qos["proc_scale"] = max(PROC_SCALE_MIN, g_qos["proc_scale"] - 0.05)
                elif avg_ms < FRAME_BUDGET_MS * OVERLOAD_CLEAR:
                    if g_qos["proc_scale"] < PROC_SCALE_MAX:
                        g_qos["proc_scale"] = min(PROC_SCALE_MAX, g_qos["proc_scale"] + 0.03)
                    elif g_qos["fd_stride"] > FD_STRIDE_MIN:
                        g_qos["fd_stride"] -= 1
                    elif g_qos["pose_stride"] > POSE_STRIDE_MIN:
                        g_qos["pose_stride"] -= 1

        frames += 1
        if frame_end - last_ts_fps >= 1.0:
            g_fps = frames / (frame_end - last_ts_fps)
            frames = 0
            last_ts_fps = frame_end

        time.sleep(0.002)

    pose.close(); face.close(); cap.release()

async def collect_phase_samples(phase, duration_s=3.0, min_conf=0.5, tick_ms=50):
    m_samples, eye_samples, bbox_samples = [], [], []
    end_time = time.time() + duration_s
    while time.time() < end_time:
        with g_metric_lock: m = g_latest_metric; c = g_latest_confidence
        with g_feat_lock: f = dict(g_features)
        if m is not None and c >= min_conf: m_samples.append(m)
        if f.get("eyes_visible") and f.get("eye_dist") is not None: eye_samples.append(float(f["eye_dist"]))
        if f.get("has_face") and f.get("bbox_area") is not None:    bbox_samples.append(float(f["bbox_area"]))
        await asyncio.sleep(tick_ms / 1000.0)

    def summarize(arr):
        if len(arr) < 5: return None, None, 0
        mean = sum(arr) / len(arr); var = sum((x - mean)**2 for x in arr) / len(arr)
        return mean, var**0.5, len(arr)

    if len(m_samples) < 10:
        return {"ok": False, "reason": "insufficient_samples", "n": len(m_samples)}

    m_mean, m_std, n_m = summarize(m_samples)
    eye_mean, eye_std, n_eye = summarize(eye_samples)
    bbox_mean, bbox_std, n_bbox = summarize(bbox_samples)
    stable = m_std <= max(0.6, 0.05 * abs(m_mean))
    return {
        "ok": True, "n": n_m, "mean": m_mean, "std": m_std, "stable": stable,
        "face_means": {"eye_dist": eye_mean, "bbox_area": bbox_mean, "eye_n": n_eye, "bbox_n": n_bbox}
    }

async def ws_sender(websocket):
    last_sent_state = ""
    last_hb_time = 0.0
    try:
        while True:
            with g_state_lock:
                s = g_current_state
            with g_qos_lock:
                hb_interval = g_qos["hb_interval"]
            if s != last_sent_state:
                await websocket.send(json.dumps({
                    "type": "state",
                    "v": 6,
                    "state": s,
                    "policy": "fused_hysteresis_confidence",
                }))
                last_sent_state = s

            now = time.time()
            if now - last_hb_time >= hb_interval:
                with g_metric_lock:
                    m = g_latest_metric; c = g_latest_confidence
                with g_feat_lock:
                    feats = dict(g_features)
                with g_fused_lock:
                    fr = g_fused_raw; fe = g_fused_ema
                with g_health_lock:
                    health = dict(g_health)
                with g_qos_lock:
                    perf = {
                        "target_fps": TARGET_FPS,
                        "avg_ms": round(g_qos["avg_ms"], 1),
                        "fd_stride": g_qos["fd_stride"],
                        "pose_stride": g_qos["pose_stride"],
                        "proc_scale": round(g_qos["proc_scale"], 2),
                        "overload": g_qos["overload"],
                        "hb_interval_ms": int(hb_interval*1000),
                        "res_cam": list(g_qos["cam_res"]),
                        "res_proc": list(g_qos["proc_res"]),
                        "cpu_pct": (round(g_qos["cpu_pct"],1) if g_qos["cpu_pct"] is not None else None)
                    }
                hb = {
                    "type": "hb",
                    "fps": round(g_fps, 1),
                    "metric_nose_z_x100": m,
                    "confidence": None,
                    "features": feats,
                    "fused": {"raw": fr, "ema": fe},
                    "health": health,
                    "perf": perf,
                    "transition": {
                        "target": g_transition_target,
                        "elapsed_ms": int((now - g_transition_start_ts) * 1000.0) if g_transition_target else 0,
                        "required_ms": (FUSED_DWELL_REVIEW_MS if g_transition_target == "REVIEW"
                                        else (FUSED_DWELL_FOCUS_MS if g_transition_target == "FOCUS" else 0))
                    }
                }
                brightness = health.get("brightness"); blur_var = health.get("blur_var")
                c_bri = norm_quality(brightness, BRIGHTNESS_MIN, BRIGHTNESS_GOOD) if brightness is not None else 0.0
                c_blr = norm_quality(blur_var,  BLUR_MIN,       BLUR_GOOD) if blur_var is not None else 0.0
                c_q = min(c_bri, c_blr)
                z_norm = None; eye_norm = None; bbox_norm = None
                try:
                    rv = load_calibration_cache.get("review_mean") if load_calibration_cache else None
                    fc = load_calibration_cache.get("focus_mean")  if load_calibration_cache else None
                    if m is not None: z_norm = lin_norm_near1(m, rv, fc)
                    eye_norm = lin_norm_near1(feats.get("eye_dist"),
                                              g_face_calib["review"]["eye_dist"],
                                              g_face_calib["focus"]["eye_dist"])
                    bbox_norm = lin_norm_near1(feats.get("bbox_area"),
                                               g_face_calib["review"]["bbox_area"],
                                               g_face_calib["focus"]["bbox_area"])
                except Exception: pass
                c_z   = 1.0 if (feats.get("has_pose") and z_norm is not None) else 0.0
                fs = max(0.0, min(1.0, feats.get("face_score") or 0.0))
                c_eye = fs if (feats.get("eyes_visible") and eye_norm is not None) else 0.0
                c_box = fs if (feats.get("has_face") and bbox_norm is not None) else 0.0
                overall_conf = 0.4*c_z + 0.3*c_eye + 0.2*c_box + 0.1*c_q
                hb["confidence"] = round(overall_conf, 3)

                await websocket.send(json.dumps(hb))
                last_hb_time = now

            await asyncio.sleep(0.02)
    except websockets.exceptions.ConnectionClosed:
        return

def probe_cameras(max_index=6):
    found = []
    for i in range(max_index):
        try:
            cap = cv2.VideoCapture(i)
            ok, _ = cap.read()
            cap.release()
            if ok:
                found.append(i)
        except Exception:
            try:
                cap.release()
            except Exception:
                pass
    return found

async def ws_receiver(websocket):
    phase_values = {"REVIEW": None, "FOCUS": None}
    phase_faces  = {"REVIEW": None, "FOCUS": None}
    global g_cam_switch_request, g_cam_index
    try:
        async for msg in websocket:
            try:
                data = json.loads(msg)
            except Exception:
                continue
            cmd = data.get("cmd")

            if cmd == "cameras":
                try:
                    indices = await asyncio.to_thread(probe_cameras, 6)
                except Exception:
                    indices = []
                await websocket.send(json.dumps({"type": "cameras", "list": indices, "current": int(g_cam_index)}))

            if cmd == "switch_camera":
                idx = int(data.get("index", 0))
                ok = False
                try:
                    cap = cv2.VideoCapture(idx)
                    ok, _ = cap.read()
                    cap.release()
                except Exception:
                    ok = False
                if ok:
                    g_cam_switch_request = idx
                    await websocket.send(json.dumps({"type": "ack", "what": "switch_camera", "ok": True, "index": idx}))
                else:
                    await websocket.send(json.dumps({"type": "ack", "what": "switch_camera", "ok": False, "index": idx, "reason": "open_failed"}))

            if cmd == "calibrate_phase":
                phase = data.get("phase"); dur = float(data.get("duration_s", 3.0))
                await websocket.send(json.dumps({"type": "calib_status", "phase": phase, "status": "sampling"}))
                res = await collect_phase_samples(phase, duration_s=dur)
                if not res["ok"]:
                    await websocket.send(json.dumps({"type": "calib_status", "phase": phase, "status": "error",
                                                     "reason": res.get("reason", "unknown")}))
                    continue
                phase_values[phase] = res
                phase_faces[phase] = res.get("face_means", {})
                await websocket.send(json.dumps({
                    "type": "calib_result_phase",
                    "phase": phase, "mean": round(res["mean"], 3), "std": round(res["std"], 3),
                    "n": res["n"], "stable": res["stable"], "face_means": phase_faces[phase]
                }))
            if cmd == "calibrate_finalize":
                pr = phase_values["REVIEW"]; pf = phase_values["FOCUS"]
                if not pr or not pf:
                    await websocket.send(json.dumps({"type": "calib_status", "status": "error", "reason": "missing_phase"})); continue
                saved = save_calibration(
                    pr["mean"], pr["std"], pf["mean"], pf["std"],
                    dwell_ms=750, face_review=phase_faces["REVIEW"], face_focus=phase_faces["FOCUS"]
                )
                globals()["load_calibration_cache"] = saved
                await websocket.send(json.dumps({"type": "calib_done", "saved": saved}))

            if cmd == "set_conf_min":
                try:
                    v = float(data.get("value", CONF_MIN))
                    globals()["CONF_MIN"] = max(0.0, min(1.0, v))
                    await websocket.send(json.dumps({"type": "ack", "what": "set_conf_min", "value": CONF_MIN}))
                except Exception:
                    await websocket.send(json.dumps({"type": "ack", "what": "set_conf_min", "error": True}))

            if cmd == "set_qos":
                with g_qos_lock:
                    if "proc_scale" in data:
                        v = float(data["proc_scale"])
                        g_qos["proc_scale"] = max(PROC_SCALE_MIN, min(PROC_SCALE_MAX, v))
                    if "fd_stride" in data:
                        v = int(data["fd_stride"])
                        g_qos["fd_stride"] = max(FD_STRIDE_MIN, min(FD_STRIDE_MAX, v))
                    if "pose_stride" in data:
                        v = int(data["pose_stride"])
                        g_qos["pose_stride"] = max(POSE_STRIDE_MIN, min(POSE_STRIDE_MAX, v))
                if "target_fps" in data:
                    try:
                        v = float(data["target_fps"])
                        globals()["TARGET_FPS"] = max(10.0, min(30.0, v))
                        globals()["FRAME_BUDGET_MS"] = 1000.0 / TARGET_FPS
                    except Exception:
                        pass
                await websocket.send(json.dumps({"type": "ack", "what": "set_qos", "qos": g_qos}))

    except websockets.exceptions.ConnectionClosed:
        return

async def handler(websocket):
    print(f"[ws] Client connected: {websocket.remote_address}")
    try:
        sender_task = asyncio.create_task(ws_sender(websocket))
        receiver_task = asyncio.create_task(ws_receiver(websocket))
        done, pending = await asyncio.wait({sender_task, receiver_task}, return_when=asyncio.FIRST_COMPLETED)
        for t in pending: t.cancel()
    finally:
        print(f"[ws] Client disconnected: {websocket.remote_address}")

async def main():
    port = 8765
    print(f"[ws] Starting WebSocket server on ws://localhost:{port}")
    async with websockets.serve(handler, "localhost", port, ping_interval=10, ping_timeout=10):
        await asyncio.Future()

load_calibration_cache = None

def parse_args():
    p = argparse.ArgumentParser(description="Dynamic Workspace sensor")
    p.add_argument("--port", type=int, default=8765, help="WebSocket port (default 8765)")
    p.add_argument("--camera", type=int, default=0, help="Camera index (default 0)")
    p.add_argument("--fps", type=float, default=TARGET_FPS, help="Processing target FPS")
    return p.parse_args()

if __name__ == "__main__":
    args = parse_args()
    globals()["TARGET_FPS"] = max(10.0, min(30.0, float(args.fps)))
    globals()["FRAME_BUDGET_MS"] = 1000.0 / TARGET_FPS

    globals()["g_cam_index"] = int(args.camera)

    load_calibration_cache = load_calibration()
    print(f"[main] Starting pose/face thread (cam={args.camera}, target_fps={TARGET_FPS})...")

    pose_thread = threading.Thread(target=run_pose_detection, daemon=True)

    pose_thread.start()
    print(f"[main] Starting WebSocket server on ws://localhost:{args.port} ...")
    async def _main_with_port(port:int):
        global _WS_PORT; _WS_PORT = port
        await main_with_port(port)
    async def main_with_port(port:int):
        print(f"[ws] Starting WebSocket server on ws://localhost:{port}")
        async with websockets.serve(handler, "localhost", port, ping_interval=10, ping_timeout=10):
            await asyncio.Future()
    asyncio.run(_main_with_port(args.port))
