import { parseTelemetryV2, TelemetryPayloadV2 } from "./schemas/telemetry-v2";

export interface Env {
  GOOGLE_CLIENT_EMAIL: string;
  GOOGLE_PRIVATE_KEY: string;
  SPREADSHEET_ID: string;
}

type Sheet = { properties: { title: string; sheetId: number } };

let sheetsWriteBackoffMs = 0;
let sheetsWriteBlockedUntilMs = 0;
const MIN_SHEETS_WRITE_BACKOFF_MS = 15_000;
const MAX_SHEETS_WRITE_BACKOFF_MS = 15 * 60_000;

type DevicePlatform = "esp32" | "pico2w";

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

async function upsertDevice(
  env: Env,
  token: string,
  deviceId: string,
  wifiSsid: string,
  timestamp: string,
  platform?: DevicePlatform,
) {
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
    return;
  }

  const updateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}/values/Devices!A${rowIndex + 1}:D${rowIndex + 1}?valueInputOption=USER_ENTERED`;
  await fetch(updateUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values: [rowData] }),
  });
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
  async fetch(request: Request, env: Env): Promise<Response> {
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
        if (shouldThrottleSheetsWrites()) {
          return jsonResponse({
            success: true,
            message: "Telemetry received. Google Sheets quota is temporarily full; DB updates are being slowed automatically.",
            throttled: true,
            retry_after_ms: Math.max(0, sheetsWriteBlockedUntilMs - Date.now()),
          });
        }
        const timestamp = new Date().toISOString();
        const deviceId = telemetry.device_id;
        const status = telemetry.status || "Unknown";
        const wifiSsid = telemetry.wifi_ssid || "Unknown";
        const platform = normalizeDevicePlatform(telemetry.device_platform, deviceId);

        const token = await getGoogleAuthToken(env.GOOGLE_CLIENT_EMAIL, env.GOOGLE_PRIVATE_KEY);
        const appendUrl = `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}/values/Sheet1:append?valueInputOption=USER_ENTERED`;
        const sheetsRes = await fetch(appendUrl, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            values: [[
              timestamp,
              deviceId,
              telemetry.schema_version,
              telemetry.session_id,
              telemetry.session_state,
              telemetry.exercise_id,
              JSON.stringify(telemetry),
              status,
              wifiSsid,
            ]],
          }),
        });
        const sheetsData: any = await sheetsRes.json();

        if (sheetsData?.error) {
          throw new Error(`Error writing telemetry: ${JSON.stringify(sheetsData.error)}`);
        }

        await appendSessionSample(env, token, telemetry, timestamp);
        await upsertSession(env, token, telemetry, timestamp);
        await appendEvents(env, token, telemetry, timestamp);
        await upsertDevice(env, token, deviceId, wifiSsid, timestamp, platform);

        handleSheetsWriteSuccess();

        return jsonResponse({ success: true, message: "Telemetry received and saved.", data: sheetsData });
      } catch (e: any) {
        if (isGoogleSheetsQuotaError(e)) {
          handleSheetsQuotaExceeded();
          return jsonResponse({
            success: true,
            message: "Telemetry received. Google Sheets quota is temporarily full; DB updates are being slowed automatically.",
            throttled: true,
            retry_after_ms: Math.max(0, sheetsWriteBlockedUntilMs - Date.now()),
          });
        }
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

        const token = await getGoogleAuthToken(env.GOOGLE_CLIENT_EMAIL, env.GOOGLE_PRIVATE_KEY);
        await upsertDevice(env, token, deviceId, wifiSsid, new Date().toISOString(), platform);

        return jsonResponse({ success: true, message: "Device registered." });
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

        return jsonResponse({ success: true, devices });
      } catch (e: any) {
        return jsonResponse({ error: e.message }, { status: 500 });
      }
    }

    const commandRoute = url.pathname.match(/^\/api\/devices\/(.+)\/command$/);
    if (commandRoute && request.method === "POST") {
      try {
        const token = await getGoogleAuthToken(env.GOOGLE_CLIENT_EMAIL, env.GOOGLE_PRIVATE_KEY);
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

        await queueDeviceCommand(env, token, deviceId, command, {
          wifi_ssid: body.wifi_ssid || "",
          wifi_password: body.wifi_password || "",
          session_id: body.session_id || "",
          exercise_id: body.exercise_id || "",
          rep_target: Number(body.rep_target || 0),
        });
        return jsonResponse({ success: true, message: "Command queued. The board will apply it on its next command check." });
      } catch (e: any) {
        return jsonResponse({ error: e.message }, { status: 500 });
      }
    }

    if (request.method === "POST" && url.pathname === "/api/sessions/start") {
      try {
        const body: any = await request.json();
        const deviceId = String(body.device_id || "");
        if (!deviceId) return jsonResponse({ error: "device_id is required" }, { status: 400 });
        const token = await getGoogleAuthToken(env.GOOGLE_CLIENT_EMAIL, env.GOOGLE_PRIVATE_KEY);
        const sessionId = String(body.session_id || `${deviceId}_${Date.now()}`);
        const exerciseId = String(body.exercise_id || "general");
        const repTarget = Number(body.rep_target || 10);
        const now = new Date().toISOString();

        await appendSheetRow(env, token, "Sessions", [
          sessionId,
          deviceId,
          exerciseId,
          "calibrate",
          now,
          "",
          String(repTarget),
          "0",
          "incorrect",
          "0",
          now,
        ]);
        await queueDeviceCommand(env, token, deviceId, "START_SESSION", {
          session_id: sessionId,
          exercise_id: exerciseId,
          rep_target: repTarget,
        });
        return jsonResponse({ success: true, session_id: sessionId });
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
        const token = await getGoogleAuthToken(env.GOOGLE_CLIENT_EMAIL, env.GOOGLE_PRIVATE_KEY);
        await queueDeviceCommand(env, token, deviceId, "END_SESSION", { session_id: sessionId });
        return jsonResponse({ success: true, session_id: sessionId });
      } catch (e: any) {
        return jsonResponse({ error: e.message }, { status: 500 });
      }
    }

    if (request.method === "GET" && url.pathname === "/api/sessions/latest") {
      try {
        const deviceId = url.searchParams.get("device_id");
        if (!deviceId) return jsonResponse({ error: "device_id is required" }, { status: 400 });
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
        return jsonResponse({ success: true, session: latest });
      } catch (e: any) {
        return jsonResponse({ error: e.message }, { status: 500 });
      }
    }

    const deviceRoute = url.pathname.match(/^\/api\/devices\/(.+)$/);
    if (deviceRoute && request.method === "DELETE") {
      try {
        const token = await getGoogleAuthToken(env.GOOGLE_CLIENT_EMAIL, env.GOOGLE_PRIVATE_KEY);
        const deviceId = decodeURIComponent(deviceRoute[1]);
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

        const token = await getGoogleAuthToken(env.GOOGLE_CLIENT_EMAIL, env.GOOGLE_PRIVATE_KEY);
        const command = await getPendingCommand(env, token, deviceId);
        return jsonResponse({ success: true, command });
      } catch (e: any) {
        return jsonResponse({ error: e.message }, { status: 500 });
      }
    }

    if (request.method === "GET" && url.pathname === "/api/debug/telemetry") {
      try {
        const deviceId = url.searchParams.get("device_id");
        const limitRaw = Number.parseInt(url.searchParams.get("limit") || "20", 10);
        const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 20;
        const token = await getGoogleAuthToken(env.GOOGLE_CLIENT_EMAIL, env.GOOGLE_PRIVATE_KEY);
        const samples = await listRecentTelemetry(env, token, deviceId, limit);
        return jsonResponse({ success: true, samples });
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
