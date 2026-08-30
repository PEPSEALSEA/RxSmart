# RxSmart Developer & Agent Guide (AGENTS.md)

> **Context for AI Agents & Developers**: This document provides a high-level system overview, technical architecture, current project state, and a roadmap of tasks for future development.

---

## 1. Project Overview & Objectives

**RxSmart** is an intelligent physical therapy & rehabilitation system designed to track, analyze, and score patient exercises in real-time.

### Key Architecture: Hybrid Motion Tracking
1. **IMU Mode (Hardware)**: 9x MPU6050 6-DOF IMUs connected to a **Raspberry Pi Pico 2 W (RP2350)** via 2x TCA9548A multiplexers. High precision, ideal for clinics/hospitals.
2. **Camera Mode (Vision)**: Local RGB camera processed using **MediaPipe Pose + OpenCV** in Python (`rxsmart-local`). Contactless, ideal for home usage.
3. **Fusion Mode (Hybrid)**: Fuses IMU and Camera pose streams via a Complementary Filter for occlusion handling and drift correction.
4. **Cloud / Storage (Dual Support)**:
   - **Firebase Realtime Database (RTDB) & Hosting** (`rxsmart-rehab-2026.web.app`): Real-time live telemetry stream, device commands, and web app static hosting.
   - **Cloudflare Workers & Google Sheets** (Legacy/Secondary): Long-term session archiving and automated logging.

---

## 2. System Components & Repository Structure

```
RxSmart/
├── AGENTS.md                           ← Master context & development roadmap (This file)
├── Pico2W.ino                          ← Core firmware (Raspberry Pi Pico 2 W)
├── hardware_connection_pico2w.txt      ← 9-sensor wiring diagram (TCA9548A x2 + MPU6050 x9)
│
├── dashboard/                          ← Next.js 16 Web Dashboard (Tailwind CSS, Three.js)
│   ├── src/app/page.tsx                ← Main rehabilitation UI & real-time 3D pose viewer
│   ├── src/app/admin/page.tsx          ← Device management, live sensor telemetry, command queue
│   ├── src/lib/firebase.ts             ← Firebase RTDB real-time listeners & command dispatcher
│   ├── src/lib/pose-physics.ts         ← Exercise scoring engine & physics simulation
│   ├── src/lib/rehab-exercises.ts      ← Exercise definitions (angles, phases, hold times)
│   └── src/lib/glb-pose-map.ts         ← 3D athlete mannequin bone mapper (Mixamo rig)
│
├── rxsmart-local/                      ← Local Python pipeline (OpenCV + MediaPipe)
│   ├── main.py                         ← Camera event loop & debug viewer
│   ├── camera_pose_engine.py           ← MediaPipe pose angle calculations
│   ├── iot_receiver.py                 ← Receiver for Pico 2 W telemetry (Serial/HTTP/LAN)
│   ├── system_mode_manager.py          ← Mode switcher & Complementary Filter fusion engine
│   └── web_bridge.py                   ← Local bridge pushing camera/fusion frames to Web Dashboard
│
├── cloudflare-worker/                  ← Cloudflare backend (REST API + Google Sheets logging)
├── scripts/                            ← Utilities (Google Apps Script RTDB -> Sheets backup)
└── firebase.json / .firebaserc         ← Firebase project configuration (`rxsmart-rehab-2026`)
```

---

## 3. Strict Development Rules

1. **Board Target is Raspberry Pi Pico 2 W (RP2350) ONLY**:
   - Never generate or re-introduce ESP32 code/docs.
   - Use Pico 2 W APIs (`LittleFS`, `rp2040.restart()`, `TwoWire` pin remapping).
   - Sensor count is **9 MPUs**: 8 limbs on TCA9548A `0x70` (CH0–7) + 1 center/torso on TCA9548A `0x71` (CH0).
2. **Environment & Secrets**:
   - Never commit API keys, service accounts, or private credentials.
   - Firebase Web Config in `firebase.ts` is client-safe public config for the `rxsmart-rehab-2026` project.
3. **Commit & Deployment**:
   - Push to `origin/main`.
   - Web dashboard deploys automatically to GitHub Pages via GitHub Actions and can be deployed to Firebase Hosting with `npx firebase-tools deploy --only hosting`.

---

## 4. Current State & What Has Been Done

- [x] **Firmware (Pico 2 W)**:
  - Multi-sensor reading (9x MPU6050) via Dual TCA9548A multiplexers.
  - On-board joint angle calculation, velocity, rep counting, posture alerts, and session state machine.
  - WiFi captive portal, OTA update support, and real-time HTTPS telemetry streaming to Firebase RTDB (`/rxsmart/devices/{id}/live`).
  - Remote command fetching (`/rxsmart/devices/{id}/command`).
- [x] **Firebase RTDB & Hosting Integration**:
  - Live data subscription in Web Dashboard (`subscribeDevices`, `subscribeLiveTelemetry`).
  - Remote device command dispatching from Web Admin.
  - Firebase Hosting active at `https://rxsmart-rehab-2026.web.app`.
  - Dynamic `basePath` resolution for both Firebase root hosting and GitHub Pages subpath (`/RxSmart`).
- [x] **Local Vision Pipeline (`rxsmart-local`)**:
  - MediaPipe Pose joint tracking and complementary filter fusion with IMU.
  - Real-time debug split-screen viewer.

---

## 5. Roadmap & What Should Be Done Next (Actionable Priorities)

### 🔴 Priority 1: End-to-End Live Scoring Integration (P0)
*Currently, the Web Dashboard scoring engine works in Physics Simulation mode, but live IMU/Camera streams are only rendered without scoring.*
- [ ] **Bridge Live Telemetry to RehabSessionEngine**:
  - In `dashboard/src/app/page.tsx`, feed live sensor angles (`SensorFrame`) directly into `RehabSessionEngine.tick()` instead of bypassing it with `makeLiveFeedback()`.
  - Ensure rep counts, phase detection (e.g. extension/flexion), and precision scores are computed from actual incoming sensor/camera frames.
- [ ] **Plane / Elevation Angle Mapping**:
  - Enhance `mapTelemetryToFrame()` in `dashboard/src/lib/pose.ts` so shoulder/hip abduction and rotational movements (e.g., swimming, T-pose) map both elevation and horizontal planes correctly.

### 🟡 Priority 2: WebRTC / WebSocket Camera Bridge to Dashboard (P1)
- [ ] Connect `rxsmart-local` (Python MediaPipe) directly to the web dashboard via local WebSocket (`web_bridge.py`) so users can use the camera mode on the web UI with live pose overlay.
- [ ] Implement in-browser MediaPipe Pose (WebAssembly/JS) as an alternative zero-install camera mode inside `dashboard/src/components/CameraView.tsx`.

### 🟢 Priority 3: Clinical Session Export & History (P2)
- [ ] Store completed exercise session summaries (total reps, ROM max/min, error rate, smoothness score) in Firebase RTDB under `rxsmart/sessions/{sessionId}`.
- [ ] Add a Session History & Report view for physiotherapists in the Dashboard (charting ROM improvements and tracking patient compliance).
- [ ] Trigger automated periodic backup from Firebase RTDB to Google Sheets via `scripts/firebase-to-sheets-backup.gs`.
