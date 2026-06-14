export type SessionState = "idle" | "calibrate" | "exercise" | "complete";

export type PostureState = "correct" | "incorrect";

export interface TelemetrySensorV2 {
  key: string;
  pin: number;
  raw: number;
  zero_offset: number;
  calibrated: number;
  timestamp_ms: number;
}

export interface TelemetryAnglesV2 {
  elbow_left: number;
  elbow_right: number;
  knee_left: number;
  knee_right: number;
  primary: number;
}

export interface TelemetryPostureV2 {
  state: PostureState;
  fault_mask: number;
  stability_score: number;
}

export interface TelemetryAlertV2 {
  level: "warn" | "critical";
  code: number;
}

export interface TelemetryPayloadV2 {
  schema_version: number;
  firmware_version: string;
  device_ts_ms: number;
  device_id: string;
  status: string;
  wifi_ssid: string;
  calibrated: boolean;
  session_id: string;
  session_state: SessionState;
  exercise_id: string;
  session_started_ms: number;
  session_completed_ms: number;
  rep_target: number;
  summary_pending: boolean;
  sensors: TelemetrySensorV2[];
  angles: TelemetryAnglesV2;
  speed_dps: number;
  rep_count: number;
  posture: TelemetryPostureV2;
  alerts: TelemetryAlertV2[];
}

function asNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function isSessionState(value: string): value is SessionState {
  return value === "idle" || value === "calibrate" || value === "exercise" || value === "complete";
}

function isPostureState(value: string): value is PostureState {
  return value === "correct" || value === "incorrect";
}

export function parseTelemetryV2(input: unknown): TelemetryPayloadV2 | null {
  if (!input || typeof input !== "object") return null;
  const body = input as Record<string, unknown>;
  const sensorsRaw = Array.isArray(body.sensors) ? body.sensors : [];
  if (sensorsRaw.length !== 8) return null;

  const sensors: TelemetrySensorV2[] = sensorsRaw.map((item) => {
    const sensor = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    return {
      key: asString(sensor.key, ""),
      pin: asNumber(sensor.pin),
      raw: asNumber(sensor.raw),
      zero_offset: asNumber(sensor.zero_offset),
      calibrated: asNumber(sensor.calibrated),
      timestamp_ms: asNumber(sensor.timestamp_ms),
    };
  });

  const anglesRaw = body.angles && typeof body.angles === "object" ? (body.angles as Record<string, unknown>) : {};
  const postureRaw = body.posture && typeof body.posture === "object" ? (body.posture as Record<string, unknown>) : {};
  const alertsRaw = Array.isArray(body.alerts) ? body.alerts : [];
  const sessionState = asString(body.session_state, "idle");
  const postureState = asString(postureRaw.state, "incorrect");
  if (!isSessionState(sessionState) || !isPostureState(postureState)) return null;

  return {
    schema_version: asNumber(body.schema_version, 2),
    firmware_version: asString(body.firmware_version, ""),
    device_ts_ms: asNumber(body.device_ts_ms),
    device_id: asString(body.device_id, ""),
    status: asString(body.status, "Unknown"),
    wifi_ssid: asString(body.wifi_ssid, "Unknown"),
    calibrated: asBoolean(body.calibrated),
    session_id: asString(body.session_id, ""),
    session_state: sessionState,
    exercise_id: asString(body.exercise_id, "general"),
    session_started_ms: asNumber(body.session_started_ms),
    session_completed_ms: asNumber(body.session_completed_ms),
    rep_target: asNumber(body.rep_target),
    summary_pending: asBoolean(body.summary_pending),
    sensors,
    angles: {
      elbow_left: asNumber(anglesRaw.elbow_left),
      elbow_right: asNumber(anglesRaw.elbow_right),
      knee_left: asNumber(anglesRaw.knee_left),
      knee_right: asNumber(anglesRaw.knee_right),
      primary: asNumber(anglesRaw.primary),
    },
    speed_dps: asNumber(body.speed_dps),
    rep_count: asNumber(body.rep_count),
    posture: {
      state: postureState,
      fault_mask: asNumber(postureRaw.fault_mask),
      stability_score: asNumber(postureRaw.stability_score),
    },
    alerts: alertsRaw
      .map((item) => {
        const alert = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
        const level = asString(alert.level, "warn");
        if (level !== "warn" && level !== "critical") return null;
        return { level, code: asNumber(alert.code) };
      })
      .filter((item): item is TelemetryAlertV2 => item !== null),
  };
}
