# โครงสร้างระบบ IoT & Web App (Pico 2 W + Next.js + Cloudflare Workers + Google Sheets)

This document outlines the architecture, setup process, and implementation details for the end-to-end IoT and Web Application system you requested.

> ESP32 is retired. Active firmware is `Pico2W.ino` only.

## User Review Required

> [!IMPORTANT]
> Please review the architecture, directory structure, and credentials management approach below. If this aligns with your expectations, please approve the plan so we can proceed with execution.

## Proposed Architecture & Changes

We will create a multi-project workspace inside the current directory (`e:\Github2\RxSmart`).

### 1. Pico 2 W Firmware (`Pico2W.ino`)
The board firmware is an Arduino sketch (arduino-pico core) using:
- `WiFi.h`, `WebServer.h`, `DNSServer.h`: For normal connection and the Captive Portal.
- `LittleFS`: To save and retrieve WiFi credentials.
- `HTTPClient.h`: For Watchdog checks, Telemetry POST requests.
- `HTTPUpdate.h`: For Over-the-Air (OTA) updates.
- `ArduinoJson.h`: For parsing version info and sending telemetry data.

**Key Mechanisms:**
- **Smart WiFi:** Attempts to connect using stored credentials. Fails -> creates `RxSmart-Setup` AP with a Captive Portal.
- **Watchdog:** Periodic HTTP GET to `google.com`. If no response, restart / re-enter setup.
- **OTA:** HTTP GET to Cloudflare `/api/firmware-version?platform=pico2w`. If version mismatch, download `.bin` and flash.
- **Telemetry:** HTTP POST to Cloudflare `/api/telemetry` (`device_platform: pico2w`, 9 sensors).

### 2. Cloudflare Workers Backend (`/cloudflare-worker`)
We will create a new folder and initialize a Cloudflare Workers project using Wrangler (`npm create cloudflare@latest`).

**Endpoints:**
- `GET /api/firmware-version`: Returns JSON `{ "latest_version": "1.0.1", "bin_url": "https://..." }`.
- `POST /api/telemetry`: Receives telemetry data, authenticates with Google Service Account (using raw JWT generation or lightweight library), and forwards data to Google Sheets via REST API.

**Wrangler Commands:**
- Compile/Run locally: `npx wrangler dev`
- Deploy: `npx wrangler deploy`
- Set Secrets: `npx wrangler secret put GOOGLE_PRIVATE_KEY`

### 3. Next.js Dashboard (`/dashboard`)
We will create a Next.js App Router project for the dashboard using modern UI design (vibrant colors, glassmorphism, responsive).

**"Fix Sheet" Functionality:**
- The Next.js API route will use the official `googleapis` library.
- When triggered, it will update the range `Sheet1!A1:Z1` (Row 1 only) with the standard template: `['Timestamp', 'Device_ID', 'Sensor_Value', 'Status']`.
- > [!WARNING]
  > We will strictly use the `update` method on Row 1. We will NOT use `clear` or delete rows, ensuring data from Row 2 onwards remains completely untouched.

### 4. Credentials & Environment Setup
We will set up `.env` files and recommend `.gitignore` rules to keep your keys safe.

**Required Keys:**
- `NEXT_PUBLIC_API_URL`
- `GOOGLE_CLIENT_EMAIL`
- `GOOGLE_PRIVATE_KEY`
- `SPREADSHEET_ID`

> [!TIP]
> The `.env` file will be heavily ignored in Git. For Cloudflare, keys like `GOOGLE_PRIVATE_KEY` will be pushed using Wrangler secrets, not baked into the code.

## Verification Plan

### Automated / Code Checks
- Ensure C++ code compiles without syntax errors (simulated via strict adherence to Arduino API).
- Ensure Next.js and Cloudflare Workers type-check successfully.

### Manual Verification
- You will be instructed to run `npx wrangler dev` to test the worker.
- You will be instructed to flash the ESP32 and test the Captive Portal on your phone.
- You will test the "Fix Sheet" button on the Next.js local server to verify that ONLY the header changes in Google Sheets.
