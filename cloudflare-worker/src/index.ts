import { parseTelemetryV2, TelemetryPayloadV2 } from "./schemas/telemetry-v2";

export interface Env {
  GOOGLE_CLIENT_EMAIL: string;
  GOOGLE_PRIVATE_KEY: string;
  SPREADSHEET_ID: string;
}

type Sheet = { properties: { title: string; sheetId: number } };

type DevicePlatform = "esp32" | "pico2w";

type DebugTelemetryRow = {
  timestamp: string;
  device_id: string;
  schema_version: number;
  session_id: string;
  session_state: string;
  exercise_id: string;
  payload_json: unknown;
  status: string;
  wifi_ssid: string;
};

type DeviceRecord = {
  device_id: string;
  wifi_ssid: string;
  last_online: string;
  platform: DevicePlatform;
};

type SessionRecord = {
  session_id: string;
  device_id: string;
  exercise_id: string;
  state: string;
  started_at: string;
  ended_at: string;
  rep_target: number;
  rep_final: number;
  posture_state: string;
  posture_fault_mask: number;
  updated_at: string;
};

type CachedCommand = {
  device_id: string;
  command: string;
  wifi_ssid: string;
  wifi_password: string;
  session_id: string;
  exercise_id: string;
  rep_target: number;
  created_at: string;
  consumed: boolean;
};

let sheetsWriteBackoffMs = 0;
let sheetsWriteBlockedUntilMs = 0;
const MIN_SHEETS_WRITE_BACKOFF_MS = 15_000;
const MAX_SHEETS_WRITE_BACKOFF_MS = 15 * 60_000;
const SHEETS_FLUSH_INTERVAL_MS = 5_000;
const TELEMETRY_CACHE_MAX = 200;

let lastSheetsFlushMs = 0;
let oldestBufferedAtMs = 0;
let sheetsFlushInFlight: Promise<void> | null = null;

const telemetrySheetBuffer: string[][] = [];
const sessionSampleBuffer: string[][] = [];
const eventsBuffer: string[][] = [];
const commandsArchiveBuffer: string[][] = [];
const telemetryCache: DebugTelemetryRow[] = [];
const devicesCache = new Map<string, DeviceRecord>();
const sessionsCache = new Map<string, SessionRecord>();
const deviceFlushPending = new Map<string, DeviceRecord>();
const sessionFlushPending = new Map<string, { telemetry: TelemetryPayloadV2; timestamp: string }>();
const commandQueue: CachedCommand[] = [];

const FIRMWARE_BY_PLATFORM: Record<DevicePlatform, { latest_version: string; bin_url: string }> = {
  esp32: { latest_version: "1.0.0", bin_url: "" },
  pico2w: { latest_version: "1.0.0", bin_url: "" },
};

const sheetHeaders: Record<string, string[]> = {
  Sheet1: ["Timestamp", "Device_ID", "Schema_Version", "Session_ID", "Session_State", "Exercise_ID", "Payload_JSON", "Status", "WiFi_SSID"],
  Devices: ["Device_ID", "WiFi_SSID", "Last_Online", "Platform"],
  Commands: ["Device_ID", "Command", "WiFi_SSID", "WiFi_Password", "Session_ID", "Exercise_ID", "Rep_Target", "Created_At", "Status"],
  DebugSamples: ["Timestamp", "Device_ID", "Pose_Name", "Test_Target", "Sensor_Map", "Packet_JSON", "Notes"],
  PoseLibrary: ["Created_At", "Pose_Name", "Test_Target", "Sensor_Map", "Reference_JSON", "Device_ID"],
  Sessions: ["Session_ID", "Device_ID", "Exercise_ID", "State", "Started_At", "Ended_At", "Rep_Target", "Rep_Final", "Posture_State", "Posture_Fault_Mask", "Updated_At"],
  SessionSamples: ["Timestamp", "Device_ID", "Session_ID", "Session_State", "Exercise_ID", "Payload_JSON"],
  Events: ["Timestamp", "Device_ID", "Session_ID", "Alert_Level", "Alert_Code", "Detail_JSON"],
};

const jsonHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Content-Type": "application/json",
};

function jsonResponse(payload: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(payload), {
    ...init,
    headers: { ...jsonHeaders, ...(init.headers || {}) },
  });
}

function isGoogleSheetsQuotaError(raw: unknown): boolean {
  const message = String(
    raw && typeof raw === "object" && "message" in raw
      ? (raw as { message?: string }).message || ""
      : raw || "",
  ).toLowerCase();

  return message.includes("quota")
    || message.includes("resource_exhausted")
    || message.includes("rate limit")
    || message.includes("too many requests")
    || message.includes("user_rate_limit_exceeded");
}

function handleSheetsQuotaExceeded() {
  const current = sheetsWriteBackoffMs > 0
    ? Math.min(sheetsWriteBackoffMs * 2, MAX_SHEETS_WRITE_BACKOFF_MS)
    : MIN_SHEETS_WRITE_BACKOFF_MS;
  sheetsWriteBackoffMs = current;
  sheetsWriteBlockedUntilMs = Date.now() + current;
}

function handleSheetsWriteSuccess() {
  sheetsWriteBlockedUntilMs = 0;
  sheetsWriteBackoffMs = sheetsWriteBackoffMs > MIN_SHEETS_WRITE_BACKOFF_MS
    ? Math.floor(sheetsWriteBackoffMs / 2)
    : 0;
}

function shouldThrottleSheetsWrites() {
  return Date.now() < sheetsWriteBlockedUntilMs;
}

type QueueCommandPayload = {
  wifi_ssid?: string;
  wifi_password?: string;
  session_id?: string;
  exercise_id?: string;
  rep_target?: number;
};

type DebugSample = {
  timestamp: string;
  device_id: string;
  pose_name: string;
  test_target: string;
  sensor_map: string;
  packet_json: string;
  notes: string;
};

type PoseTemplate = {
  created_at: string;
  pose_name: string;
  test_target: string;
  sensor_map: string;
  reference_json: string;
  device_id: string;
};

function normalizeDevicePlatform(value: unknown, deviceId = ""): DevicePlatform {
  const raw = String(value || "").toLowerCase().trim();
  if (raw === "pico2w" || raw === "pico_2w" || raw === "pico-2w" || raw === "raspberry_pi_pico_2w") {
    return "pico2w";
  }
  if (raw === "esp32") return "esp32";

  const id = deviceId.toUpperCase();
  if (id.startsWith("PICO2W_")) return "pico2w";
  if (id.startsWith("ESP32_")) return "esp32";
  return "esp32";
}

function parseMaybeJson(raw: string): unknown {
  if (!raw) return "";
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function base64url(source: string | Uint8Array): string {
  const encoded = typeof source === "string"
    ? btoa(source)
    : btoa(String.fromCharCode(...new Uint8Array(source)));
  return encoded.replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function str2ab(str: string): ArrayBuffer {
  const buf = new ArrayBuffer(str.length);
  const bufView = new Uint8Array(buf);
  for (let i = 0, strLen = str.length; i < strLen; i++) {
    bufView[i] = str.charCodeAt(i);
  }
  return buf;
}

async function getGoogleAuthToken(clientEmail: string, privateKey: string): Promise<string> {
  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: clientEmail,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };

  const encodedHeader = base64url(JSON.stringify(header));
  const encodedClaim = base64url(JSON.stringify(claim));
  const signatureInput = `${encodedHeader}.${encodedClaim}`;

  const pemHeader = "-----BEGIN PRIVATE KEY-----";
  const pemFooter = "-----END PRIVATE KEY-----";
  const pkStr = privateKey.replace(/\\n/g, "\n");
  if (!pkStr.includes(pemHeader)) {
    throw new Error("Invalid private key format");
  }

  const pemContents = pkStr.substring(
    pkStr.indexOf(pemHeader) + pemHeader.length,
    pkStr.indexOf(pemFooter),
  ).replace(/\s/g, "");

  const binaryDer = atob(pemContents);
  const derBuffer = str2ab(binaryDer);

  const key = await crypto.subtle.importKey(
    "pkcs8",
    derBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: { name: "SHA-256" } },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signatureInput),
  );

  const jwt = `${signatureInput}.${base64url(new Uint8Array(signature))}`;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });

  const tokenData: any = await tokenRes.json();
  if (!tokenData.access_token) {
    throw new Error(`Failed to get Google Access Token: ${JSON.stringify(tokenData)}`);
  }
  return tokenData.access_token;
}

async function getSpreadsheetSheets(env: Env, token: string): Promise<Sheet[]> {
  const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}?fields=sheets.properties.title,sheets.properties.sheetId`;
  const metaRes = await fetch(metaUrl, { headers: { Authorization: `Bearer ${token}` } });
  const metaData: any = await metaRes.json();
  return metaData.sheets || [];
}

async function ensureSheet(env: Env, token: string, title: string): Promise<number | null> {
  const sheets = await getSpreadsheetSheets(env, token);
  const existing = sheets.find((sheet) => sheet.properties.title === title);
  if (existing) {
    await ensureSheetHeader(env, token, title, existing.properties.sheetId);
    return existing.properties.sheetId;
  }

  const batchUrl = `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}:batchUpdate`;
  const createRes = await fetch(batchUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      requests: [{ addSheet: { properties: { title } } }],
    }),
  });
  const createData: any = await createRes.json();
  const sheetId = createData.replies?.[0]?.addSheet?.properties?.sheetId || null;
  if (sheetId !== null) {
    await ensureSheetHeader(env, token, title, sheetId);
  }
  return sheetId;
}

async function ensureSheetHeader(env: Env, token: string, title: string, sheetId: number) {
  const headers = sheetHeaders[title];
  if (!headers) return;

  const getUrl = `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}/values/${title}!1:1`;
  const getRes = await fetch(getUrl, { headers: { Authorization: `Bearer ${token}` } });
  const getData: any = await getRes.json();
  const firstRow: string[] = getData.values?.[0] || [];
  const hasExpectedHeader = headers.every((header, index) => firstRow[index] === header);

  if (hasExpectedHeader) return;

  if (firstRow.length > 0) {
    const batchUrl = `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}:batchUpdate`;
    await fetch(batchUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: [{
          insertDimension: {
            range: {
              sheetId,
              dimension: "ROWS",
              startIndex: 0,
              endIndex: 1,
            },
            inheritFromBefore: false,
          },
        }],
      }),
    });
  }

  const updateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}/values/${title}!1:1?valueInputOption=USER_ENTERED`;
  await fetch(updateUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values: [headers] }),
  });
}

async function readSheetValues(env: Env, token: string, range: string): Promise<string[][]> {
  const getUrl = `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}/values/${range}`;
  const getRes = await fetch(getUrl, { headers: { Authorization: `Bearer ${token}` } });
  const data: any = await getRes.json();
  if (data.error) {
    throw new Error(`Error reading range ${range}: ${JSON.stringify(data.error)}`);
  }
  return data.values || [];
}

async function appendSheetRow(env: Env, token: string, sheet: string, values: string[]) {
  await ensureSheet(env, token, sheet);
  const appendUrl = `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}/values/${sheet}:append?valueInputOption=USER_ENTERED`;
  await fetch(appendUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values: [values] }),
  });
}

async function batchAppendSheetRows(env: Env, token: string, sheet: string, rows: string[][]) {
  if (rows.length === 0) return;
  await ensureSheet(env, token, sheet);
  const appendUrl = `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}/values/${sheet}:append?valueInputOption=USER_ENTERED`;
  const res = await fetch(appendUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values: rows }),
  });
  const data: any = await res.json();
  if (data?.error) {
    throw new Error(`Error batch writing ${sheet}: ${JSON.stringify(data.error)}`);
  }
}

function pushTelemetryCache(row: DebugTelemetryRow) {
  telemetryCache.push(row);
  if (telemetryCache.length > TELEMETRY_CACHE_MAX) {
    telemetryCache.splice(0, telemetryCache.length - TELEMETRY_CACHE_MAX);
  }
}

function cacheDevice(deviceId: string, wifiSsid: string, timestamp: string, platform: DevicePlatform) {
  const record: DeviceRecord = {
    device_id: deviceId,
    wifi_ssid: wifiSsid,
    last_online: timestamp,
    platform,
  };
  devicesCache.set(deviceId, record);
  deviceFlushPending.set(deviceId, record);
}

function cacheSessionFromTelemetry(telemetry: TelemetryPayloadV2, timestamp: string) {
  if (!telemetry.session_id) return;
  const existing = sessionsCache.get(telemetry.session_id);
  const record: SessionRecord = {
    session_id: telemetry.session_id,
    device_id: telemetry.device_id,
    exercise_id: telemetry.exercise_id || "general",
    state: telemetry.session_state,
    started_at: telemetry.session_started_ms
      ? new Date(telemetry.session_started_ms).toISOString()
      : (existing?.started_at || ""),
    ended_at: telemetry.session_completed_ms
      ? new Date(telemetry.session_completed_ms).toISOString()
      : (existing?.ended_at || ""),
    rep_target: telemetry.rep_target || existing?.rep_target || 0,
    rep_final: telemetry.rep_count || existing?.rep_final || 0,
    posture_state: telemetry.posture.state,
    posture_fault_mask: telemetry.posture.fault_mask || 0,
    updated_at: timestamp,
  };
  sessionsCache.set(telemetry.session_id, record);
  sessionFlushPending.set(telemetry.session_id, { telemetry, timestamp });
}

function ingestTelemetry(telemetry: TelemetryPayloadV2, timestamp: string) {
  if (telemetrySheetBuffer.length === 0) {
    oldestBufferedAtMs = Date.now();
  }

  const status = telemetry.status || "Unknown";
  const wifiSsid = telemetry.wifi_ssid || "Unknown";
  const platform = normalizeDevicePlatform(telemetry.device_platform, telemetry.device_id);

  telemetrySheetBuffer.push([
    timestamp,
    telemetry.device_id,
    String(telemetry.schema_version),
    telemetry.session_id,
    telemetry.session_state,
    telemetry.exercise_id,
    JSON.stringify(telemetry),
    status,
    wifiSsid,
  ]);

  pushTelemetryCache({
    timestamp,
    device_id: telemetry.device_id,
    schema_version: telemetry.schema_version,
    session_id: telemetry.session_id,
    session_state: telemetry.session_state,
    exercise_id: telemetry.exercise_id,
    payload_json: telemetry,
    status,
    wifi_ssid: wifiSsid,
  });

  sessionSampleBuffer.push([
    timestamp,
    telemetry.device_id,
    telemetry.session_id,
    telemetry.session_state,
    telemetry.exercise_id || "general",
    JSON.stringify(telemetry),
  ]);

  for (const alert of telemetry.alerts) {
    eventsBuffer.push([
      timestamp,
      telemetry.device_id,
      telemetry.session_id,
      alert.level,
      String(alert.code),
      JSON.stringify({
        speed_dps: telemetry.speed_dps,
        posture_fault_mask: telemetry.posture.fault_mask,
        rep_count: telemetry.rep_count,
      }),
    ]);
  }

  cacheDevice(telemetry.device_id, wifiSsid, timestamp, platform);
  cacheSessionFromTelemetry(telemetry, timestamp);
}

function queueCommandInCache(
  deviceId: string,
  command: string,
  payload: QueueCommandPayload = {},
) {
  const createdAt = new Date().toISOString();
  commandQueue.push({
    device_id: deviceId,
    command,
    wifi_ssid: payload.wifi_ssid || "",
    wifi_password: payload.wifi_password || "",
    session_id: payload.session_id || "",
    exercise_id: payload.exercise_id || "",
    rep_target: Number(payload.rep_target || 0),
    created_at: createdAt,
    consumed: false,
  });
}

function getPendingCommandFromCache(deviceId: string) {
  const index = commandQueue.findIndex((entry) => entry.device_id === deviceId && !entry.consumed);
  if (index === -1) return null;

  const row = commandQueue[index];
  row.consumed = true;

  commandsArchiveBuffer.push([
    row.device_id,
    row.command,
    row.wifi_ssid,
    row.wifi_password,
    row.session_id,
    row.exercise_id,
    String(row.rep_target),
    row.created_at,
    "consumed",
  ]);

  return {
    command: row.command,
    wifi_ssid: row.wifi_ssid,
    wifi_password: row.wifi_password,
    session_id: row.session_id,
    exercise_id: row.exercise_id,
    rep_target: row.rep_target,
    created_at: row.created_at,
  };
}

function listTelemetryFromCache(deviceId: string | null, limit: number): DebugTelemetryRow[] {
  const rows = telemetryCache
    .filter((row) => (deviceId ? row.device_id === deviceId : true))
    .slice(-limit)
    .reverse();
  return rows;
}

function hasBufferedSheetsData() {
  return telemetrySheetBuffer.length > 0
    || sessionSampleBuffer.length > 0
    || eventsBuffer.length > 0
    || commandsArchiveBuffer.length > 0
    || deviceFlushPending.size > 0
    || sessionFlushPending.size > 0;
}

function shouldFlushSheetsNow() {
  if (!hasBufferedSheetsData()) return false;
  const now = Date.now();
  return now - lastSheetsFlushMs >= SHEETS_FLUSH_INTERVAL_MS
    || now - oldestBufferedAtMs >= SHEETS_FLUSH_INTERVAL_MS;
}

async function flushToSheets(env: Env) {
  if (!hasBufferedSheetsData()) return;
  if (shouldThrottleSheetsWrites()) return;

  const sheet1Rows = telemetrySheetBuffer.splice(0);
  const sampleRows = sessionSampleBuffer.splice(0);
  const eventRows = eventsBuffer.splice(0);
  const commandRows = commandsArchiveBuffer.splice(0);
  const devicesToFlush = new Map(deviceFlushPending);
  deviceFlushPending.clear();
  const sessionsToFlush = new Map(sessionFlushPending);
  sessionFlushPending.clear();

  if (
    sheet1Rows.length === 0
    && sampleRows.length === 0
    && eventRows.length === 0
    && commandRows.length === 0
    && devicesToFlush.size === 0
    && sessionsToFlush.size === 0
  ) {
    return;
  }

  try {
    const token = await getGoogleAuthToken(env.GOOGLE_CLIENT_EMAIL, env.GOOGLE_PRIVATE_KEY);

    await batchAppendSheetRows(env, token, "Sheet1", sheet1Rows);
    await batchAppendSheetRows(env, token, "SessionSamples", sampleRows);
    await batchAppendSheetRows(env, token, "Events", eventRows);
    await batchAppendSheetRows(env, token, "Commands", commandRows);

    for (const device of devicesToFlush.values()) {
      await upsertDevice(env, token, device.device_id, device.wifi_ssid, device.last_online, device.platform);
    }

    for (const entry of sessionsToFlush.values()) {
      await upsertSession(env, token, entry.telemetry, entry.timestamp);
    }

    handleSheetsWriteSuccess();
    oldestBufferedAtMs = 0;
  } catch (e) {
    telemetrySheetBuffer.unshift(...sheet1Rows);
    sessionSampleBuffer.unshift(...sampleRows);
    eventsBuffer.unshift(...eventRows);
    commandsArchiveBuffer.unshift(...commandRows);
    for (const [key, value] of devicesToFlush) {
      deviceFlushPending.set(key, value);
    }
    for (const [key, value] of sessionsToFlush) {
      sessionFlushPending.set(key, value);
    }
    if (telemetrySheetBuffer.length > 0 && oldestBufferedAtMs === 0) {
      oldestBufferedAtMs = Date.now();
    }
    if (isGoogleSheetsQuotaError(e)) {
      handleSheetsQuotaExceeded();
      return;
    }
    throw e;
  }
}

function scheduleSheetsFlush(env: Env, ctx: ExecutionContext) {
  if (!shouldFlushSheetsNow()) return;
  if (sheetsFlushInFlight) return;

  lastSheetsFlushMs = Date.now();
  sheetsFlushInFlight = flushToSheets(env).finally(() => {
    sheetsFlushInFlight = null;
  });
  ctx.waitUntil(sheetsFlushInFlight);
}

async function getDeviceFromSheet(env: Env, token: string, deviceId: string): Promise<DeviceRecord | null> {
  await ensureSheet(env, token, "Devices");
  const rows = await readSheetValues(env, token, "Devices!A:D");
  const row = rows.find((entry) => entry?.[0] === deviceId);
  if (!row) return null;

  return {
    device_id: row[0] || deviceId,
    wifi_ssid: row[1] || "Unknown",
    last_online: row[2] || "",
    platform: normalizeDevicePlatform(row[3], row[0] || deviceId),
  };
}

async function upsertDevice(
  env: Env,
  token: string,
  deviceId: string,
  wifiSsid: string,
  timestamp: string,
  platform?: DevicePlatform,
): Promise<{ created: boolean; exists_before: boolean }> {
  await ensureSheet(env, token, "Devices");
  const getUrl = `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}/values/Devices!A:A`;
  const getRes = await fetch(getUrl, { headers: { Authorization: `Bearer ${token}` } });
  const getData: any = await getRes.json();
  const rows = getData.values || [];
  const rowIndex = rows.findIndex((row: string[]) => row?.[0] === deviceId);
  const rowData = [deviceId, wifiSsid, timestamp, platform || normalizeDevicePlatform("", deviceId)];

  if (rowIndex === -1) {
    const appendUrl = `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}/values/Devices:append?valueInputOption=USER_ENTERED`;
    await fetch(appendUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [rowData] }),
    });
    return { created: true, exists_before: false };
  }

  const updateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}/values/Devices!A${rowIndex + 1}:D${rowIndex + 1}?valueInputOption=USER_ENTERED`;
  await fetch(updateUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values: [rowData] }),
  });
  return { created: false, exists_before: true };
}

async function deleteDevice(env: Env, token: string, deviceId: string) {
  const sheetId = await ensureSheet(env, token, "Devices");
  if (sheetId === null) throw new Error("Devices sheet not found");

  const getUrl = `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}/values/Devices!A:A`;
  const getRes = await fetch(getUrl, { headers: { Authorization: `Bearer ${token}` } });
  const getData: any = await getRes.json();
  const rows = getData.values || [];
  const rowIndex = rows.findIndex((row: string[]) => row?.[0] === deviceId);

  if (rowIndex === -1) return false;

  const batchUrl = `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}:batchUpdate`;
  await fetch(batchUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      requests: [{
        deleteDimension: {
          range: {
            sheetId,
            dimension: "ROWS",
            startIndex: rowIndex,
            endIndex: rowIndex + 1,
          },
        },
      }],
    }),
  });

  return true;
}

async function queueDeviceCommand(
  env: Env,
  token: string,
  deviceId: string,
  command: string,
  payload: QueueCommandPayload = {},
) {
  await ensureSheet(env, token, "Commands");
  const appendUrl = `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}/values/Commands:append?valueInputOption=USER_ENTERED`;
  await fetch(appendUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      values: [[
        deviceId,
        command,
        payload.wifi_ssid || "",
        payload.wifi_password || "",
        payload.session_id || "",
        payload.exercise_id || "",
        payload.rep_target ?? "",
        new Date().toISOString(),
        "",
      ]],
    }),
  });
}

async function getPendingCommand(env: Env, token: string, deviceId: string) {
  await ensureSheet(env, token, "Commands");
  const getUrl = `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}/values/Commands!A:I`;
  const getRes = await fetch(getUrl, { headers: { Authorization: `Bearer ${token}` } });
  const getData: any = await getRes.json();
  const rows: string[][] = getData.values || [];
  const rowIndex = rows.findIndex((row) => row?.[0] === deviceId && row?.[1] && row?.[8] !== "consumed");

  if (rowIndex === -1) return null;

  const row = rows[rowIndex];
  const updateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}/values/Commands!I${rowIndex + 1}?valueInputOption=USER_ENTERED`;
  await fetch(updateUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values: [["consumed"]] }),
  });

  return {
    command: row[1],
    wifi_ssid: row[2] || "",
    wifi_password: row[3] || "",
    session_id: row[4] || "",
    exercise_id: row[5] || "",
    rep_target: Number.parseInt(row[6] || "0", 10) || 0,
    created_at: row[7] || "",
  };
}

async function listRecentTelemetry(env: Env, token: string, deviceId: string | null, limit: number): Promise<DebugTelemetryRow[]> {
  const rows = await readSheetValues(env, token, "Sheet1!A:I");

  const telemetryRows = rows
    .filter((row) => row[0] && row[0] !== "Timestamp")
    .map((row) => ({
      timestamp: row[0] || "",
      device_id: row[1] || "",
      schema_version: Number.parseInt(row[2] || "2", 10) || 2,
      session_id: row[3] || "",
      session_state: row[4] || "idle",
      exercise_id: row[5] || "",
      payload_json: parseMaybeJson(row[6] || ""),
      status: row[7] || "",
      wifi_ssid: row[8] || "",
    }))
    .filter((row) => (deviceId ? row.device_id === deviceId : true));

  return telemetryRows.slice(Math.max(0, telemetryRows.length - limit)).reverse();
}

async function listDebugSamples(env: Env, token: string, deviceId: string | null, limit: number): Promise<DebugSample[]> {
  const rows = await readSheetValues(env, token, "DebugSamples!A:G");
  const samples = rows
    .filter((row) => row[0] && row[0] !== "Timestamp")
    .map((row) => ({
      timestamp: row[0] || "",
      device_id: row[1] || "",
      pose_name: row[2] || "",
      test_target: row[3] || "",
      sensor_map: row[4] || "",
      packet_json: row[5] || "",
      notes: row[6] || "",
    }))
    .filter((row) => (deviceId ? row.device_id === deviceId : true));
  return samples.slice(Math.max(0, samples.length - limit)).reverse();
}

async function listPoseLibrary(env: Env, token: string, limit: number): Promise<PoseTemplate[]> {
  const rows = await readSheetValues(env, token, "PoseLibrary!A:F");
  const poses = rows
    .filter((row) => row[0] && row[0] !== "Created_At")
    .map((row) => ({
      created_at: row[0] || "",
      pose_name: row[1] || "",
      test_target: row[2] || "",
      sensor_map: row[3] || "",
      reference_json: row[4] || "",
      device_id: row[5] || "",
    }));
  return poses.slice(Math.max(0, poses.length - limit)).reverse();
}

async function upsertSession(env: Env, token: string, telemetry: TelemetryPayloadV2, timestamp: string) {
  if (!telemetry.session_id) return;
  await ensureSheet(env, token, "Sessions");
  const rows = await readSheetValues(env, token, "Sessions!A:K");
  const rowIndex = rows.findIndex((row) => row?.[0] === telemetry.session_id);
  const rowData = [
    telemetry.session_id,
    telemetry.device_id,
    telemetry.exercise_id || "general",
    telemetry.session_state,
    telemetry.session_started_ms ? new Date(telemetry.session_started_ms).toISOString() : "",
    telemetry.session_completed_ms ? new Date(telemetry.session_completed_ms).toISOString() : "",
    String(telemetry.rep_target || 0),
    String(telemetry.rep_count || 0),
    telemetry.posture.state,
    String(telemetry.posture.fault_mask || 0),
    timestamp,
  ];

  if (rowIndex === -1) {
    await appendSheetRow(env, token, "Sessions", rowData);
    return;
  }

  const updateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}/values/Sessions!A${rowIndex + 1}:K${rowIndex + 1}?valueInputOption=USER_ENTERED`;
  await fetch(updateUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values: [rowData] }),
  });
}

async function appendSessionSample(env: Env, token: string, telemetry: TelemetryPayloadV2, timestamp: string) {
  await appendSheetRow(env, token, "SessionSamples", [
    timestamp,
    telemetry.device_id,
    telemetry.session_id,
    telemetry.session_state,
    telemetry.exercise_id || "general",
    JSON.stringify(telemetry),
  ]);
}

async function appendEvents(env: Env, token: string, telemetry: TelemetryPayloadV2, timestamp: string) {
  if (!telemetry.alerts.length) return;
  for (const alert of telemetry.alerts) {
    await appendSheetRow(env, token, "Events", [
      timestamp,
      telemetry.device_id,
      telemetry.session_id,
      alert.level,
      String(alert.code),
      JSON.stringify({
        speed_dps: telemetry.speed_dps,
        posture_fault_mask: telemetry.posture.fault_mask,
        rep_count: telemetry.rep_count,
      }),
    ]);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    if (request.method === "GET" && url.pathname === "/api/firmware-version") {
      const deviceId = url.searchParams.get("device_id") || "";
      const platform = normalizeDevicePlatform(url.searchParams.get("platform"), deviceId);
      const firmware = FIRMWARE_BY_PLATFORM[platform];
      return jsonResponse({
        platform,
        latest_version: firmware.latest_version,
        bin_url: firmware.bin_url,
      });
    }

    if (request.method === "POST" && url.pathname === "/api/telemetry") {
      try {
        const body: any = await request.json();
        const telemetry = parseTelemetryV2(body);
        if (!telemetry || !telemetry.device_id) {
          return jsonResponse({ error: "Invalid telemetry v2 payload" }, { status: 400 });
        }

        const timestamp = new Date().toISOString();
        ingestTelemetry(telemetry, timestamp);
        scheduleSheetsFlush(env, ctx);

        const throttled = shouldThrottleSheetsWrites();
        return jsonResponse({
          success: true,
          buffered: true,
          message: throttled
            ? "Telemetry buffered. Google Sheets flush is paused due to quota backoff."
            : "Telemetry buffered. Google Sheets will be updated in batch.",
          throttled,
          retry_after_ms: throttled ? Math.max(0, sheetsWriteBlockedUntilMs - Date.now()) : 0,
        });
      } catch (e: any) {
        return jsonResponse({ error: e.message }, { status: 500 });
      }
    }

    if (request.method === "POST" && url.pathname === "/api/devices/register") {
      try {
        const body: any = await request.json();
        const deviceId = body.device_id || "";
        const wifiSsid = body.wifi_ssid || "Unknown";
        const platform = normalizeDevicePlatform(body.device_platform, deviceId);

        if (!deviceId) {
          return jsonResponse({ error: "device_id is required" }, { status: 400 });
        }

        const timestamp = new Date().toISOString();
        const existed = devicesCache.has(deviceId);
        cacheDevice(deviceId, wifiSsid, timestamp, platform);
        scheduleSheetsFlush(env, ctx);

        return jsonResponse({
          success: true,
          device_id: deviceId,
          exists_before: existed,
          created: !existed,
          buffered: true,
          message: existed
            ? "Device refreshed in cache and queued for Google Sheets batch save."
            : "Device added to cache and queued for Google Sheets batch save.",
        });
      } catch (e: any) {
        return jsonResponse({ error: e.message }, { status: 500 });
      }
    }

    if (request.method === "POST" && url.pathname === "/api/fix-sheet") {
      try {
        const token = await getGoogleAuthToken(env.GOOGLE_CLIENT_EMAIL, env.GOOGLE_PRIVATE_KEY);
        await ensureSheet(env, token, "Sheet1");
        await ensureSheet(env, token, "Devices");
        await ensureSheet(env, token, "Commands");
        await ensureSheet(env, token, "DebugSamples");
        await ensureSheet(env, token, "PoseLibrary");
        await ensureSheet(env, token, "Sessions");
        await ensureSheet(env, token, "SessionSamples");
        await ensureSheet(env, token, "Events");

        return jsonResponse({
          success: true,
          message: "Sheet headers fixed and all tabs validated without overwriting data.",
        });
      } catch (e: any) {
        return jsonResponse({ error: e.message }, { status: 500 });
      }
    }

    if (request.method === "GET" && url.pathname === "/api/devices") {
      try {
        if (devicesCache.size > 0) {
          return jsonResponse({
            success: true,
            devices: Array.from(devicesCache.values()),
            source: "cache",
          });
        }

        const token = await getGoogleAuthToken(env.GOOGLE_CLIENT_EMAIL, env.GOOGLE_PRIVATE_KEY);
        await ensureSheet(env, token, "Devices");

        const getUrl = `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}/values/Devices!A:D`;
        const getRes = await fetch(getUrl, { headers: { Authorization: `Bearer ${token}` } });
        const data: any = await getRes.json();

        if (data.error) {
          throw new Error(`Error reading Devices sheet: ${JSON.stringify(data.error)}`);
        }

        const devices = (data.values || [])
          .filter((row: string[]) => row[0] && row[0] !== "Device_ID")
          .map((row: string[]) => ({
            device_id: row[0] || "Unknown",
            wifi_ssid: row[1] || "Unknown",
            last_online: row[2] || "Unknown",
            platform: normalizeDevicePlatform(row[3], row[0] || ""),
          }));

        for (const device of devices) {
          devicesCache.set(device.device_id, device);
        }

        return jsonResponse({ success: true, devices, source: "sheets" });
      } catch (e: any) {
        return jsonResponse({ error: e.message }, { status: 500 });
      }
    }

    const commandRoute = url.pathname.match(/^\/api\/devices\/(.+)\/command$/);
    if (commandRoute && request.method === "POST") {
      try {
        const deviceId = decodeURIComponent(commandRoute[1]);
        const body: any = await request.json();
        const command = body.command;

        const allowedCommands = ["SET_WIFI", "CLEAR_WIFI", "START_SESSION", "END_SESSION", "RECALIBRATE"];
        if (!allowedCommands.includes(command)) {
          return jsonResponse({ error: "Invalid command" }, { status: 400 });
        }

        if (command === "SET_WIFI" && !body.wifi_ssid) {
          return jsonResponse({ error: "WiFi SSID is required" }, { status: 400 });
        }

        queueCommandInCache(deviceId, command, {
          wifi_ssid: body.wifi_ssid || "",
          wifi_password: body.wifi_password || "",
          session_id: body.session_id || "",
          exercise_id: body.exercise_id || "",
          rep_target: Number(body.rep_target || 0),
        });
        scheduleSheetsFlush(env, ctx);
        return jsonResponse({
          success: true,
          buffered: true,
          message: "Command queued in cache. The board will apply it on its next command check.",
        });
      } catch (e: any) {
        return jsonResponse({ error: e.message }, { status: 500 });
      }
    }

    if (request.method === "POST" && url.pathname === "/api/sessions/start") {
      try {
        const body: any = await request.json();
        const deviceId = String(body.device_id || "");
        if (!deviceId) return jsonResponse({ error: "device_id is required" }, { status: 400 });
        const sessionId = String(body.session_id || `${deviceId}_${Date.now()}`);
        const exerciseId = String(body.exercise_id || "general");
        const repTarget = Number(body.rep_target || 10);
        const now = new Date().toISOString();

        sessionsCache.set(sessionId, {
          session_id: sessionId,
          device_id: deviceId,
          exercise_id: exerciseId,
          state: "calibrate",
          started_at: now,
          ended_at: "",
          rep_target: repTarget,
          rep_final: 0,
          posture_state: "incorrect",
          posture_fault_mask: 0,
          updated_at: now,
        });

        sessionFlushPending.set(sessionId, {
          telemetry: {
            schema_version: 2,
            firmware_version: "",
            device_ts_ms: Date.now(),
            device_id: deviceId,
            status: "Idle",
            wifi_ssid: "",
            calibrated: false,
            session_id: sessionId,
            session_state: "calibrate",
            exercise_id: exerciseId,
            session_started_ms: Date.now(),
            session_completed_ms: 0,
            rep_target: repTarget,
            summary_pending: false,
            sensors: [],
            angles: { elbow_left: 0, elbow_right: 0, knee_left: 0, knee_right: 0, primary: 0 },
            speed_dps: 0,
            rep_count: 0,
            posture: { state: "incorrect", fault_mask: 0, stability_score: 0 },
            alerts: [],
          },
          timestamp: now,
        });

        queueCommandInCache(deviceId, "START_SESSION", {
          session_id: sessionId,
          exercise_id: exerciseId,
          rep_target: repTarget,
        });
        scheduleSheetsFlush(env, ctx);
        return jsonResponse({ success: true, session_id: sessionId, buffered: true });
      } catch (e: any) {
        return jsonResponse({ error: e.message }, { status: 500 });
      }
    }

    if (request.method === "POST" && url.pathname === "/api/sessions/complete") {
      try {
        const body: any = await request.json();
        const deviceId = String(body.device_id || "");
        const sessionId = String(body.session_id || "");
        if (!deviceId || !sessionId) {
          return jsonResponse({ error: "device_id and session_id are required" }, { status: 400 });
        }
        queueCommandInCache(deviceId, "END_SESSION", { session_id: sessionId });
        scheduleSheetsFlush(env, ctx);
        return jsonResponse({ success: true, session_id: sessionId, buffered: true });
      } catch (e: any) {
        return jsonResponse({ error: e.message }, { status: 500 });
      }
    }

    if (request.method === "GET" && url.pathname === "/api/sessions/latest") {
      try {
        const deviceId = url.searchParams.get("device_id");
        if (!deviceId) return jsonResponse({ error: "device_id is required" }, { status: 400 });

        const cached = Array.from(sessionsCache.values()).filter((row) => row.device_id === deviceId);
        if (cached.length > 0) {
          const latest = cached[cached.length - 1];
          return jsonResponse({ success: true, session: latest, source: "cache" });
        }

        const token = await getGoogleAuthToken(env.GOOGLE_CLIENT_EMAIL, env.GOOGLE_PRIVATE_KEY);
        const rows = await readSheetValues(env, token, "Sessions!A:K");
        const matches = rows
          .filter((row) => row[0] && row[0] !== "Session_ID" && row[1] === deviceId)
          .map((row) => ({
            session_id: row[0] || "",
            device_id: row[1] || "",
            exercise_id: row[2] || "",
            state: row[3] || "idle",
            started_at: row[4] || "",
            ended_at: row[5] || "",
            rep_target: Number.parseInt(row[6] || "0", 10) || 0,
            rep_final: Number.parseInt(row[7] || "0", 10) || 0,
            posture_state: row[8] || "incorrect",
            posture_fault_mask: Number.parseInt(row[9] || "0", 10) || 0,
            updated_at: row[10] || "",
          }));
        const latest = matches[matches.length - 1] || null;
        return jsonResponse({ success: true, session: latest, source: "sheets" });
      } catch (e: any) {
        return jsonResponse({ error: e.message }, { status: 500 });
      }
    }

    const deviceCheckRoute = url.pathname.match(/^\/api\/devices\/(.+)\/check$/);
    if (deviceCheckRoute && request.method === "GET") {
      try {
        const deviceId = decodeURIComponent(deviceCheckRoute[1]);
        if (!deviceId) return jsonResponse({ error: "device_id is required" }, { status: 400 });

        const cached = devicesCache.get(deviceId);
        if (cached) {
          return jsonResponse({
            success: true,
            device_id: deviceId,
            exists: true,
            device: cached,
            source: "cache",
          });
        }

        const token = await getGoogleAuthToken(env.GOOGLE_CLIENT_EMAIL, env.GOOGLE_PRIVATE_KEY);
        const device = await getDeviceFromSheet(env, token, deviceId);
        if (device) {
          devicesCache.set(deviceId, device);
        }
        return jsonResponse({
          success: true,
          device_id: deviceId,
          exists: device !== null,
          device,
          source: "sheets",
        });
      } catch (e: any) {
        return jsonResponse({ error: e.message }, { status: 500 });
      }
    }

    const deviceRoute = url.pathname.match(/^\/api\/devices\/(.+)$/);
    if (deviceRoute && request.method === "DELETE") {
      try {
        const deviceId = decodeURIComponent(deviceRoute[1]);
        devicesCache.delete(deviceId);
        deviceFlushPending.delete(deviceId);

        const token = await getGoogleAuthToken(env.GOOGLE_CLIENT_EMAIL, env.GOOGLE_PRIVATE_KEY);
        const deleted = await deleteDevice(env, token, deviceId);
        return jsonResponse({ success: true, deleted });
      } catch (e: any) {
        return jsonResponse({ error: e.message }, { status: 500 });
      }
    }

    if (request.method === "GET" && url.pathname === "/api/commands") {
      try {
        const deviceId = url.searchParams.get("device_id");
        if (!deviceId) return jsonResponse({ error: "device_id is required" }, { status: 400 });

        const cached = getPendingCommandFromCache(deviceId);
        if (cached) {
          scheduleSheetsFlush(env, ctx);
          return jsonResponse({ success: true, command: cached, source: "cache" });
        }

        const token = await getGoogleAuthToken(env.GOOGLE_CLIENT_EMAIL, env.GOOGLE_PRIVATE_KEY);
        const command = await getPendingCommand(env, token, deviceId);
        return jsonResponse({ success: true, command, source: "sheets" });
      } catch (e: any) {
        return jsonResponse({ error: e.message }, { status: 500 });
      }
    }

    if (request.method === "GET" && url.pathname === "/api/debug/telemetry") {
      try {
        const deviceId = url.searchParams.get("device_id");
        const limitRaw = Number.parseInt(url.searchParams.get("limit") || "20", 10);
        const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 20;

        const cached = listTelemetryFromCache(deviceId, limit);
        if (cached.length > 0) {
          return jsonResponse({ success: true, samples: cached, source: "cache" });
        }

        const token = await getGoogleAuthToken(env.GOOGLE_CLIENT_EMAIL, env.GOOGLE_PRIVATE_KEY);
        const samples = await listRecentTelemetry(env, token, deviceId, limit);
        return jsonResponse({ success: true, samples, source: "sheets" });
      } catch (e: any) {
        return jsonResponse({ error: e.message }, { status: 500 });
      }
    }

    if (request.method === "GET" && url.pathname === "/api/debug/samples") {
      try {
        const deviceId = url.searchParams.get("device_id");
        const limitRaw = Number.parseInt(url.searchParams.get("limit") || "50", 10);
        const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 300) : 50;
        const token = await getGoogleAuthToken(env.GOOGLE_CLIENT_EMAIL, env.GOOGLE_PRIVATE_KEY);
        const samples = await listDebugSamples(env, token, deviceId, limit);
        return jsonResponse({ success: true, samples });
      } catch (e: any) {
        return jsonResponse({ error: e.message }, { status: 500 });
      }
    }

    if (request.method === "POST" && url.pathname === "/api/debug/samples") {
      try {
        const body: any = await request.json();
        const timestamp = new Date().toISOString();
        const token = await getGoogleAuthToken(env.GOOGLE_CLIENT_EMAIL, env.GOOGLE_PRIVATE_KEY);
        await appendSheetRow(env, token, "DebugSamples", [
          timestamp,
          body.device_id || "Unknown",
          body.pose_name || "Untitled",
          body.test_target || "",
          JSON.stringify(body.sensor_map || {}),
          JSON.stringify(body.packet || {}),
          body.notes || "",
        ]);
        return jsonResponse({ success: true, timestamp });
      } catch (e: any) {
        return jsonResponse({ error: e.message }, { status: 500 });
      }
    }

    if (request.method === "GET" && url.pathname === "/api/debug/poses") {
      try {
        const limitRaw = Number.parseInt(url.searchParams.get("limit") || "100", 10);
        const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 100;
        const token = await getGoogleAuthToken(env.GOOGLE_CLIENT_EMAIL, env.GOOGLE_PRIVATE_KEY);
        const poses = await listPoseLibrary(env, token, limit);
        return jsonResponse({ success: true, poses });
      } catch (e: any) {
        return jsonResponse({ error: e.message }, { status: 500 });
      }
    }

    if (request.method === "POST" && url.pathname === "/api/debug/poses") {
      try {
        const body: any = await request.json();
        const createdAt = new Date().toISOString();
        const poseName = String(body.pose_name || "").trim();
        if (!poseName) return jsonResponse({ error: "pose_name is required" }, { status: 400 });

        const token = await getGoogleAuthToken(env.GOOGLE_CLIENT_EMAIL, env.GOOGLE_PRIVATE_KEY);
        await appendSheetRow(env, token, "PoseLibrary", [
          createdAt,
          poseName,
          body.test_target || "",
          JSON.stringify(body.sensor_map || {}),
          JSON.stringify(body.reference || {}),
          body.device_id || "Unknown",
        ]);
        return jsonResponse({ success: true, created_at: createdAt });
      } catch (e: any) {
        return jsonResponse({ error: e.message }, { status: 500 });
      }
    }

    return jsonResponse({ error: "Not Found" }, { status: 404 });
  },
};
