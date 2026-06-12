export interface Env {
  GOOGLE_CLIENT_EMAIL: string;
  GOOGLE_PRIVATE_KEY: string;
  SPREADSHEET_ID: string;
}

type Sheet = { properties: { title: string; sheetId: number } };

const sheetHeaders: Record<string, string[]> = {
  Sheet1: ["Timestamp", "Device_ID", "Sensor_Value", "Status", "WiFi_SSID"],
  Devices: ["Device_ID", "WiFi_SSID", "Last_Online"],
  Commands: ["Device_ID", "Command", "WiFi_SSID", "WiFi_Password", "Created_At", "Status"],
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

async function upsertDevice(env: Env, token: string, deviceId: string, wifiSsid: string, timestamp: string) {
  await ensureSheet(env, token, "Devices");
  const getUrl = `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}/values/Devices!A:A`;
  const getRes = await fetch(getUrl, { headers: { Authorization: `Bearer ${token}` } });
  const getData: any = await getRes.json();
  const rows = getData.values || [];
  const rowIndex = rows.findIndex((row: string[]) => row?.[0] === deviceId);
  const rowData = [deviceId, wifiSsid, timestamp];

  if (rowIndex === -1) {
    const appendUrl = `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}/values/Devices:append?valueInputOption=USER_ENTERED`;
    await fetch(appendUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [rowData] }),
    });
    return;
  }

  const updateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}/values/Devices!A${rowIndex + 1}:C${rowIndex + 1}?valueInputOption=USER_ENTERED`;
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
  wifiSsid = "",
  wifiPassword = "",
) {
  await ensureSheet(env, token, "Commands");
  const appendUrl = `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}/values/Commands:append?valueInputOption=USER_ENTERED`;
  await fetch(appendUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      values: [[deviceId, command, wifiSsid, wifiPassword, new Date().toISOString(), ""]],
    }),
  });
}

async function getPendingCommand(env: Env, token: string, deviceId: string) {
  await ensureSheet(env, token, "Commands");
  const getUrl = `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}/values/Commands!A:F`;
  const getRes = await fetch(getUrl, { headers: { Authorization: `Bearer ${token}` } });
  const getData: any = await getRes.json();
  const rows: string[][] = getData.values || [];
  const rowIndex = rows.findIndex((row) => row?.[0] === deviceId && row?.[1] && row?.[5] !== "consumed");

  if (rowIndex === -1) return null;

  const row = rows[rowIndex];
  const updateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}/values/Commands!F${rowIndex + 1}?valueInputOption=USER_ENTERED`;
  await fetch(updateUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values: [["consumed"]] }),
  });

  return {
    command: row[1],
    wifi_ssid: row[2] || "",
    wifi_password: row[3] || "",
    created_at: row[4] || "",
  };
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
      return jsonResponse({
        latest_version: "1.0.1",
        bin_url: "https://example.com/firmware/v1.0.1.bin",
      });
    }

    if (request.method === "POST" && url.pathname === "/api/telemetry") {
      try {
        const body: any = await request.json();
        const timestamp = new Date().toISOString();
        const deviceId = body.device_id || "Unknown";
        const sensorValue = body.sensor_value || 0;
        const status = body.status || "Unknown";
        const wifiSsid = body.wifi_ssid || "Unknown";

        const token = await getGoogleAuthToken(env.GOOGLE_CLIENT_EMAIL, env.GOOGLE_PRIVATE_KEY);
        const appendUrl = `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}/values/Sheet1:append?valueInputOption=USER_ENTERED`;
        const sheetsRes = await fetch(appendUrl, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            values: [[timestamp, deviceId, sensorValue, status, wifiSsid]],
          }),
        });
        const sheetsData = await sheetsRes.json();

        await upsertDevice(env, token, deviceId, wifiSsid, timestamp);

        return jsonResponse({ success: true, message: "Telemetry received and saved.", data: sheetsData });
      } catch (e: any) {
        return jsonResponse({ error: e.message }, { status: 500 });
      }
    }

    if (request.method === "POST" && url.pathname === "/api/devices/register") {
      try {
        const body: any = await request.json();
        const deviceId = body.device_id || "";
        const wifiSsid = body.wifi_ssid || "Unknown";

        if (!deviceId) {
          return jsonResponse({ error: "device_id is required" }, { status: 400 });
        }

        const token = await getGoogleAuthToken(env.GOOGLE_CLIENT_EMAIL, env.GOOGLE_PRIVATE_KEY);
        await upsertDevice(env, token, deviceId, wifiSsid, new Date().toISOString());

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

        return jsonResponse({ success: true, message: "Sheet headers fixed and device/command tabs validated without overwriting data." });
      } catch (e: any) {
        return jsonResponse({ error: e.message }, { status: 500 });
      }
    }

    if (request.method === "GET" && url.pathname === "/api/devices") {
      try {
        const token = await getGoogleAuthToken(env.GOOGLE_CLIENT_EMAIL, env.GOOGLE_PRIVATE_KEY);
        await ensureSheet(env, token, "Devices");

        const getUrl = `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}/values/Devices!A:C`;
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

        if (command !== "SET_WIFI" && command !== "CLEAR_WIFI") {
          return jsonResponse({ error: "Invalid command" }, { status: 400 });
        }

        if (command === "SET_WIFI" && !body.wifi_ssid) {
          return jsonResponse({ error: "WiFi SSID is required" }, { status: 400 });
        }

        await queueDeviceCommand(env, token, deviceId, command, body.wifi_ssid || "", body.wifi_password || "");
        return jsonResponse({ success: true, message: "Command queued. The board will apply it on its next command check." });
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

    return new Response("Not Found", { status: 404, headers: jsonHeaders });
  },
};
