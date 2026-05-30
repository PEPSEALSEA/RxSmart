export interface Env {
  GOOGLE_CLIENT_EMAIL: string;
  GOOGLE_PRIVATE_KEY: string;
  SPREADSHEET_ID: string;
}

// Helper to encode string to base64url
function base64url(source: string | Uint8Array): string {
  let encoded = typeof source === 'string' ? btoa(source) : btoa(String.fromCharCode(...new Uint8Array(source)));
  return encoded.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

// Convert PEM string to ArrayBuffer for Web Crypto API
function str2ab(str: string): ArrayBuffer {
  const buf = new ArrayBuffer(str.length);
  const bufView = new Uint8Array(buf);
  for (let i = 0, strLen = str.length; i < strLen; i++) {
    bufView[i] = str.charCodeAt(i);
  }
  return buf;
}

async function getGoogleAuthToken(clientEmail: string, privateKey: string): Promise<string> {
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };

  const encodedHeader = base64url(JSON.stringify(header));
  const encodedClaim = base64url(JSON.stringify(claim));
  const signatureInput = `${encodedHeader}.${encodedClaim}`;

  // Parse private key PEM
  const pemHeader = "-----BEGIN PRIVATE KEY-----";
  const pemFooter = "-----END PRIVATE KEY-----";
  // Handle literal "\n" or actual newlines
  let pkStr = privateKey.replace(/\\n/g, '\n'); 
  if (!pkStr.includes(pemHeader)) {
    throw new Error("Invalid private key format");
  }
  
  const pemContents = pkStr.substring(
    pkStr.indexOf(pemHeader) + pemHeader.length,
    pkStr.indexOf(pemFooter)
  ).replace(/\s/g, '');

  const binaryDer = atob(pemContents);
  const derBuffer = str2ab(binaryDer);

  const key = await crypto.subtle.importKey(
    'pkcs8',
    derBuffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: { name: 'SHA-256' } },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signatureInput)
  );

  const encodedSignature = base64url(new Uint8Array(signature));
  const jwt = `${signatureInput}.${encodedSignature}`;

  // Exchange JWT for Access Token
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  });

  const tokenData: any = await tokenRes.json();
  if (!tokenData.access_token) {
    throw new Error('Failed to get Google Access Token: ' + JSON.stringify(tokenData));
  }
  return tokenData.access_token;
}

// Upsert device info into Devices sheet
async function upsertDevice(env: Env, token: string, deviceId: string, wifiSsid: string, timestamp: string) {
  const getUrl = `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}/values/Devices!A:A`;
  const getRes = await fetch(getUrl, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const getData: any = await getRes.json();
  
  if (getData.error && getData.error.code === 400) {
    // If the Devices sheet doesn't exist yet, we just ignore or we can try to create it, 
    // but the user is expected to create a 'Devices' tab manually.
    console.warn("Devices sheet not found");
    return;
  }

  const rows = getData.values || [];
  let rowIndex = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i] && rows[i][0] === deviceId) {
      rowIndex = i + 1; // Sheets are 1-indexed
      break;
    }
  }

  const rowData = [deviceId, wifiSsid, timestamp];

  if (rowIndex === -1) {
    // Append new device
    const appendUrl = `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}/values/Devices:append?valueInputOption=USER_ENTERED`;
    await fetch(appendUrl, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [rowData] })
    });
  } else {
    // Update existing device
    const updateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}/values/Devices!A${rowIndex}:C${rowIndex}?valueInputOption=USER_ENTERED`;
    await fetch(updateUrl, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [rowData] })
    });
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        }
      });
    }

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json'
    };

    // Endpoint 1: Firmware Version Check
    if (request.method === 'GET' && url.pathname === '/api/firmware-version') {
      return new Response(JSON.stringify({
        latest_version: "1.0.1",
        bin_url: "https://example.com/firmware/v1.0.1.bin" 
      }), { headers: corsHeaders });
    }

    // Endpoint 2: Telemetry Data
    if (request.method === 'POST' && url.pathname === '/api/telemetry') {
      try {
        const body: any = await request.json();
        const timestamp = new Date().toISOString();
        const deviceId = body.device_id || "Unknown";
        const sensorValue = body.sensor_value || 0;
        const status = body.status || "Unknown";
        const wifiSsid = body.wifi_ssid || "Unknown";

        const token = await getGoogleAuthToken(env.GOOGLE_CLIENT_EMAIL, env.GOOGLE_PRIVATE_KEY);
        
        // 1. Append row to Sheet1 (Telemetry)
        const appendUrl = `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}/values/Sheet1:append?valueInputOption=USER_ENTERED`;
        
        const sheetsRes = await fetch(appendUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            values: [[timestamp, deviceId, sensorValue, status, wifiSsid]]
          })
        });

        const sheetsData = await sheetsRes.json();

        // 2. Upsert into Devices sheet
        await upsertDevice(env, token, deviceId, wifiSsid, timestamp);

        return new Response(JSON.stringify({ success: true, message: "Telemetry received & saved.", data: sheetsData }), { headers: corsHeaders });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
      }
    }

    // Endpoint 3: Fix Sheet Header
    if (request.method === 'POST' && url.pathname === '/api/fix-sheet') {
      try {
        const token = await getGoogleAuthToken(env.GOOGLE_CLIENT_EMAIL, env.GOOGLE_PRIVATE_KEY);
        
        const updateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}/values/Sheet1!1:1?valueInputOption=USER_ENTERED`;
        
        const headerTemplate = ['Timestamp', 'Device_ID', 'Sensor_Value', 'Status', 'WiFi_SSID'];

        const sheetsRes = await fetch(updateUrl, {
          method: 'PUT', // Use PUT for updating a specific range
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            values: [headerTemplate]
          })
        });

        const sheetsData = await sheetsRes.json();

        return new Response(JSON.stringify({ success: true, message: "Sheet header fixed successfully from Cloudflare Worker!" }), { headers: corsHeaders });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
      }
    }

    // Endpoint 4: Get All Devices
    if (request.method === 'GET' && url.pathname === '/api/devices') {
      try {
        const token = await getGoogleAuthToken(env.GOOGLE_CLIENT_EMAIL, env.GOOGLE_PRIVATE_KEY);
        
        const getUrl = `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}/values/Devices!A:C`;
        const getRes = await fetch(getUrl, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        const data: any = await getRes.json();
        
        if (data.error) {
          throw new Error('Error reading Devices sheet: ' + JSON.stringify(data.error));
        }

        const devices = (data.values || [])
          .filter((row: any[]) => row[0] && row[0] !== 'Device_ID')
          .map((row: any[]) => ({
            device_id: row[0] || 'Unknown',
            wifi_ssid: row[1] || 'Unknown',
            last_online: row[2] || 'Unknown'
          }));

        return new Response(JSON.stringify({ success: true, devices }), { headers: corsHeaders });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
      }
    }

    return new Response("Not Found", { status: 404, headers: corsHeaders });
  },
};
