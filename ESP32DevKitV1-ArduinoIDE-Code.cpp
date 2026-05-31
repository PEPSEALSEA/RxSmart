#include <WiFi.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <Preferences.h>
#include <HTTPClient.h>
#include <HTTPUpdate.h>
#include <ArduinoJson.h>
#include <WiFiClientSecure.h>

// ---------------------------------------------------------
// Configuration / การตั้งค่าระบบ
// ---------------------------------------------------------
const String CURRENT_VERSION = "1.0.0";
const String CLOUDFLARE_API_URL = "https://rxsmart-worker.sealseapep.workers.dev"; // URL ของ Cloudflare Workers

// ตั้งค่า AP & Captive Portal
const byte DNS_PORT = 53;
IPAddress apIP(192, 168, 4, 1);
DNSServer dnsServer;
WebServer server(80);
Preferences preferences;

// ตัวแปรสำหรับเช็คการเชื่อมต่อ
unsigned long previousMillis = 0;
const long watchdogInterval = 60000; // ตรวจสอบอินเทอร์เน็ตทุกๆ 1 นาที

// BOOT button = GPIO0 (built-in on ESP32 DevKit)
#define BOOT_BUTTON_PIN 0
bool inAPMode = false; // ติดตามว่าอยู่ใน AP mode ไหม

// ---------------------------------------------------------
// HTML สำหรับหน้า Captive Portal
// ---------------------------------------------------------
const char index_html[] PROGMEM = R"rawliteral(
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>RxSmart WiFi Setup</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, sans-serif; background: linear-gradient(135deg,#1a1a2e,#16213e); min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .card { background: rgba(255,255,255,0.07); backdrop-filter: blur(12px); border: 1px solid rgba(255,255,255,0.15); border-radius: 16px; padding: 32px 28px; width: 340px; color: #fff; }
    h2 { font-size: 1.4rem; margin-bottom: 6px; }
    p.sub { font-size: 0.85rem; color: #aaa; margin-bottom: 22px; }
    label { font-size: 0.82rem; color: #ccc; display: block; margin-bottom: 5px; }
    input[type=text], input[type=password] { width: 100%; padding: 11px 14px; background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); border-radius: 8px; color: #fff; font-size: 0.95rem; margin-bottom: 16px; outline: none; }
    input[type=text]:focus, input[type=password]:focus { border-color: #4ade80; }
    button { width: 100%; padding: 13px; background: #22c55e; border: none; border-radius: 8px; color: #fff; font-size: 1rem; font-weight: 600; cursor: pointer; transition: background 0.2s; }
    button:hover { background: #16a34a; }
    button:disabled { background: #555; cursor: not-allowed; }
    #status { margin-top: 16px; padding: 10px 14px; border-radius: 8px; font-size: 0.88rem; display: none; }
    #status.checking { background: rgba(250,204,21,0.15); border: 1px solid #fbbf24; color: #fbbf24; display: block; }
    #status.success { background: rgba(34,197,94,0.15); border: 1px solid #22c55e; color: #4ade80; display: block; }
    #status.error { background: rgba(239,68,68,0.15); border: 1px solid #ef4444; color: #f87171; display: block; }
  </style>
</head>
<body>
  <div class="card">
    <h2>&#x1F4F6; RxSmart Setup</h2>
    <p class="sub">Enter your WiFi credentials to connect the board to the internet.</p>
    <form id="wifiForm">
      <label for="ssid">WiFi Name (SSID)</label>
      <input type="text" id="ssid" name="ssid" placeholder="e.g. MyHomeWiFi" required autocomplete="off">
      <label for="pass">Password</label>
      <input type="password" id="pass" name="pass" placeholder="Leave blank if open network" autocomplete="off">
      <button type="submit" id="btn">&#x2714; Test &amp; Save</button>
    </form>
    <div id="status"></div>
  </div>
  <script>
    const form = document.getElementById('wifiForm');
    const btn  = document.getElementById('btn');
    const st   = document.getElementById('status');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      btn.disabled = true;
      st.className = 'checking';
      st.textContent = '&#x23F3; Testing WiFi connection... please wait (up to 15s)';
      const data = new URLSearchParams({ ssid: document.getElementById('ssid').value, pass: document.getElementById('pass').value });
      try {
        const res = await fetch('/save', { method: 'POST', body: data });
        const json = await res.json();
        if (json.success) {
          st.className = 'success';
          st.textContent = '\u2705 Connected! Board is restarting...';
        } else {
          st.className = 'error';
          st.textContent = '\u274C ' + (json.error || 'Connection failed. Check SSID / password.');
          btn.disabled = false;
        }
      } catch(err) {
        st.className = 'error';
        st.textContent = '\u274C Could not reach board. Try reloading.';
        btn.disabled = false;
      }
    });
  </script>
</body>
</html>
)rawliteral";

// ---------------------------------------------------------
// Function Declarations
// ---------------------------------------------------------
void setupAPMode();
void handleRoot();
void handleSave();
void sendCaptivePortal();
bool checkInternetWatchdog();
void checkFirmwareUpdate();
void sendTelemetryData();
void checkDeviceCommand();
String getDeviceId();
String urlEncode(const String& value);

// ---------------------------------------------------------
// Setup Function
// ---------------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(1000);
  
  // โหลดค่า WiFi จาก Preferences (NVS)
  preferences.begin("wifi_config", false);
  String savedSSID = preferences.getString("ssid", "");
  String savedPass = preferences.getString("pass", "");
  
  Serial.println("\n--- ESP32 Booting ---");
  Serial.println("Current Version: " + CURRENT_VERSION);

  if (savedSSID == "") {
    Serial.println("No WiFi credentials found. Starting Captive Portal.");
    inAPMode = true;
    setupAPMode();
    return;
  }

  // ---- ตรวจ BOOT button: กดค้างตอน power-on เพื่อ force AP mode ----
  pinMode(BOOT_BUTTON_PIN, INPUT_PULLUP);
  if (digitalRead(BOOT_BUTTON_PIN) == LOW) {
    Serial.println("BOOT button held – clearing WiFi and entering AP mode.");
    preferences.putString("ssid", "");
    preferences.putString("pass", "");
    inAPMode = true;
    setupAPMode();
    return;
  }

  Serial.print("Attempting to connect to: ");
  Serial.println(savedSSID);

  WiFi.mode(WIFI_STA);
  WiFi.begin(savedSSID.c_str(), savedPass.c_str());

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 30) {
    delay(1000);
    Serial.print(".");
    attempts++;
  }


    if (WiFi.status() == WL_CONNECTED) {
      Serial.println("\nWiFi Connected!");
      Serial.print("IP Address: ");
      Serial.println(WiFi.localIP());

      // เมื่อต่อ WiFi ได้ ให้เช็ค Internet ทันที
      if (checkInternetWatchdog()) {
        // เช็คอัปเดต Firmware จาก Cloudflare Worker
        checkFirmwareUpdate();
        checkDeviceCommand();
      } else {
        Serial.println("WiFi connected but NO INTERNET. Starting Captive Portal.");
        inAPMode = true;
        setupAPMode();
      }
    } else {
      Serial.println("\nFailed to connect. Starting Captive Portal.");
      inAPMode = true;
      setupAPMode();
    }
}

// ---------------------------------------------------------
// Loop Function
// ---------------------------------------------------------
void loop() {
  if (inAPMode || WiFi.getMode() == WIFI_AP || WiFi.getMode() == WIFI_AP_STA) {
    dnsServer.processNextRequest();
    server.handleClient();

    // กด BOOT ค้าง 3 วินาทีขณะใช้งานปกติ (เมื่ออยู่ใน AP mode อยู่แล้วไม่ต้องทำอะไร)
  } else {
    // ---- ตรวจ BOOT button ขณะใช้งานปกติ (ต่อ WiFi สำเร็จ) ----
    static unsigned long bootPressStart = 0;
    if (digitalRead(BOOT_BUTTON_PIN) == LOW) {
      if (bootPressStart == 0) bootPressStart = millis();
      if (millis() - bootPressStart >= 3000) {
        Serial.println("BOOT held 3s – clearing WiFi and restarting into AP mode.");
        preferences.putString("ssid", "");
        preferences.putString("pass", "");
        delay(200);
        ESP.restart();
      }
    } else {
      bootPressStart = 0; // รีเซ็ตถ้าปล่อยปุ่ม
    }

    unsigned long currentMillis = millis();
    if (currentMillis - previousMillis >= watchdogInterval) {
      previousMillis = currentMillis;
      
      // Internet Watchdog ทุกๆ 1 นาที
      if (!checkInternetWatchdog()) {
        Serial.println("Watchdog: No Internet detected! Rebooting into AP Mode...");
        // ล้างค่า WiFi เดิมทิ้งเพื่อให้เข้าโหมด AP ตอน Reboot (ตัวเลือกเสริม: หรือจะแค่ Restart ก็ได้)
        // preferences.putString("ssid", ""); 
        ESP.restart(); 
      } else {
        // ถ้าเน็ตปกติ ให้ส่งข้อมูล (Telemetry)
        sendTelemetryData();
        checkDeviceCommand();
      }
    }
  }
}

// ---------------------------------------------------------
// Functions สำหรับ Captive Portal
// ---------------------------------------------------------
void setupAPMode() {
  WiFi.disconnect(true);
  WiFi.setSleep(false);
  WiFi.mode(WIFI_AP);
  WiFi.softAPConfig(apIP, apIP, IPAddress(255, 255, 255, 0));
  WiFi.softAP("RxSmart-Setup-open-setup.local"); // setup WiFi name includes fallback URL

  // ตั้งค่า DNS ให้ wildcard ทุก domain ชี้มาที่ IP ของบอร์ด
  dnsServer.start(DNS_PORT, "*", apIP);

  // Web Server Routes
  server.on("/", HTTP_GET, handleRoot);
  server.on("/save", HTTP_POST, handleSave);
  server.on("/setup", HTTP_GET, sendCaptivePortal);
  server.on("/wifi", HTTP_GET, sendCaptivePortal);

  // --- Captive Portal Detection Endpoints ---
  server.on("/hotspot-detect.html", HTTP_GET, sendCaptivePortal);      // iOS / macOS
  server.on("/library/test/success.html", HTTP_GET, sendCaptivePortal);
  server.on("/generate_204", HTTP_GET, sendCaptivePortal);             // Android
  server.on("/gen_204", HTTP_GET, sendCaptivePortal);
  server.on("/mobile/status.php", HTTP_GET, sendCaptivePortal);
  server.on("/connecttest.txt", HTTP_GET, sendCaptivePortal);          // Windows
  server.on("/redirect", HTTP_GET, sendCaptivePortal);
  server.on("/ncsi.txt", HTTP_GET, sendCaptivePortal);
  server.on("/fwlink", HTTP_GET, sendCaptivePortal);
  server.on("/canonical.html", HTTP_GET, sendCaptivePortal);           // ChromeOS / Linux
  server.on("/success.txt", HTTP_GET, sendCaptivePortal);

  // Fallback: serve the setup page for every unknown URL.
  server.onNotFound(sendCaptivePortal);

  server.begin();
  Serial.println("AP Mode started. Connect to 'RxSmart-Setup-open-setup.local'. If no popup appears, open http://setup.local or http://192.168.4.1");
}

void handleRoot() {
  sendCaptivePortal();
}

void sendCaptivePortal() {
  server.sendHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  server.sendHeader("Pragma", "no-cache");
  server.sendHeader("Expires", "0");
  server.sendHeader("Location", "http://192.168.4.1", true);
  server.send(200, "text/html", index_html);
}

void handleSave() {
  if (!server.hasArg("ssid") || server.arg("ssid").length() == 0) {
    server.send(400, "application/json", "{\"success\":false,\"error\":\"SSID is required.\"}");
    return;
  }

  String newSSID = server.arg("ssid");
  String newPass = server.hasArg("pass") ? server.arg("pass") : "";

  Serial.println("[Setup] Testing WiFi: " + newSSID);

  // ---- Test WiFi connection first (switch to STA mode temporarily) ----
  WiFi.mode(WIFI_AP_STA);             // AP stays alive so phone stays connected
  WiFi.begin(newSSID.c_str(), newPass.c_str());

  unsigned long startTime = millis();
  wl_status_t wifiStatus = WL_DISCONNECTED;
  while (millis() - startTime < 15000) {   // wait up to 15 seconds
    wifiStatus = WiFi.status();
    if (wifiStatus == WL_CONNECTED || wifiStatus == WL_NO_SSID_AVAIL ||
        wifiStatus == WL_CONNECT_FAILED || wifiStatus == WL_CONNECTION_LOST) break;
    dnsServer.processNextRequest();          // keep DNS alive during wait
    server.handleClient();                   // keep portal alive during wait
    delay(300);
  }

  if (wifiStatus == WL_CONNECTED) {
    // WiFi works – save and restart
    Serial.println("[Setup] WiFi OK – saving and restarting.");
    preferences.putString("ssid", newSSID);
    preferences.putString("pass", newPass);
    server.send(200, "application/json", "{\"success\":true}");
    delay(1500);
    ESP.restart();
  } else {
    // WiFi failed – report error and stay in AP mode
    WiFi.disconnect(false);
    WiFi.mode(WIFI_AP);   // switch back to pure AP mode

    String reason;
    if (wifiStatus == WL_NO_SSID_AVAIL) {
      reason = "WiFi network '" + newSSID + "' not found. Check the name.";
    } else if (wifiStatus == WL_CONNECT_FAILED) {
      reason = "Wrong password for '" + newSSID + "'. Please retry.";
    } else {
      reason = "Could not connect to '" + newSSID + "'. Timed out (" + String(wifiStatus) + ").";
    }
    Serial.println("[Setup] Failed: " + reason);
    String jsonResp = "{\"success\":false,\"error\":\"" + reason + "\"}";
    server.send(200, "application/json", jsonResp);
  }
}

// ---------------------------------------------------------
// Internet Watchdog Function
// ---------------------------------------------------------
bool checkInternetWatchdog() {
  if (WiFi.status() != WL_CONNECTED) return false;
  
  HTTPClient http;
  // ยิง GET ไปที่ URL ที่เสถียร (ใช้ http แบบไม่เข้ารหัสเพื่อให้เร็วและลดโหลด)
  http.begin("http://clients3.google.com/generate_204"); 
  http.setTimeout(5000); // รอสูงสุด 5 วินาที
  
  int httpCode = http.GET();
  http.end();
  
  if (httpCode > 0) {
    Serial.println("Watchdog: Internet OK.");
    return true;
  } else {
    Serial.printf("Watchdog Error: %s\n", http.errorToString(httpCode).c_str());
    return false;
  }
}

// ---------------------------------------------------------
// OTA Update Function
// ---------------------------------------------------------
void checkFirmwareUpdate() {
  Serial.println("Checking for firmware updates...");
  HTTPClient http;
  String url = CLOUDFLARE_API_URL + "/api/firmware-version";
  
  http.begin(url);
  int httpCode = http.GET();
  
  if (httpCode == 200) {
    String payload = http.getString();
    
    // Parse JSON
    StaticJsonDocument<256> doc;
    DeserializationError error = deserializeJson(doc, payload);
    
    if (!error) {
      const char* latest_version = doc["latest_version"];
      const char* bin_url = doc["bin_url"];
      
      if (String(latest_version) != CURRENT_VERSION) {
        Serial.printf("New version found! (%s). Updating...\n", latest_version);
        
        // สั่งอัปเดตผ่าน OTA
        WiFiClientSecure client;
        client.setInsecure(); // ยอมรับทุก Certificate สำหรับ OTA
        t_httpUpdate_return ret = httpUpdate.update(client, bin_url);
        
        switch (ret) {
          case HTTP_UPDATE_FAILED:
            Serial.printf("HTTP_UPDATE_FAILED Error (%d): %s\n", httpUpdate.getLastError(), httpUpdate.getLastErrorString().c_str());
            break;
          case HTTP_UPDATE_NO_UPDATES:
            Serial.println("HTTP_UPDATE_NO_UPDATES");
            break;
          case HTTP_UPDATE_OK:
            Serial.println("HTTP_UPDATE_OK. Rebooting...");
            break;
        }
      } else {
        Serial.println("Firmware is up to date.");
      }
    } else {
      Serial.println("Failed to parse JSON for update check.");
    }
  } else {
    Serial.printf("Update check failed, HTTP error: %d\n", httpCode);
  }
  http.end();
}

// ---------------------------------------------------------
// Data Telemetry Function
// ---------------------------------------------------------
void sendTelemetryData() {
  Serial.println("Sending telemetry data...");
  HTTPClient http;
  String url = CLOUDFLARE_API_URL + "/api/telemetry";
  
  http.begin(url);
  http.addHeader("Content-Type", "application/json");
  
  // สร้าง JSON Payload
  StaticJsonDocument<256> doc;
  doc["device_id"] = getDeviceId();
  // สมมติค่า Sensor (สามารถเปลี่ยนเป็นการอ่านค่าจาก Sensor จริงๆ ได้)
  doc["sensor_value"] = random(20, 40); 
  doc["status"] = "Active";
  doc["wifi_ssid"] = WiFi.SSID();
  
  String jsonOutput;
  serializeJson(doc, jsonOutput);
  
  int httpCode = http.POST(jsonOutput);
  
  if (httpCode > 0) {
    Serial.printf("Telemetry Sent, Server responded with code: %d\n", httpCode);
    String response = http.getString();
    Serial.println(response);
  } else {
    Serial.printf("Telemetry Failed, Error: %s\n", http.errorToString(httpCode).c_str());
  }
  
  http.end();
}

String getDeviceId() {
  return "ESP32_" + WiFi.macAddress();
}

String urlEncode(const String& value) {
  String encoded = "";
  char hex[] = "0123456789ABCDEF";

  for (size_t i = 0; i < value.length(); i++) {
    char c = value.charAt(i);
    if (isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') {
      encoded += c;
    } else {
      encoded += '%';
      encoded += hex[(c >> 4) & 0x0F];
      encoded += hex[c & 0x0F];
    }
  }

  return encoded;
}

void checkDeviceCommand() {
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  String url = CLOUDFLARE_API_URL + "/api/commands?device_id=" + urlEncode(getDeviceId());
  http.begin(url);
  int httpCode = http.GET();

  if (httpCode != 200) {
    Serial.printf("Command check failed, HTTP error: %d\n", httpCode);
    http.end();
    return;
  }

  String payload = http.getString();
  http.end();

  StaticJsonDocument<512> doc;
  DeserializationError error = deserializeJson(doc, payload);
  if (error) {
    Serial.println("Failed to parse command response.");
    return;
  }

  JsonVariant commandNode = doc["command"];
  if (commandNode.isNull()) {
    Serial.println("No pending command.");
    return;
  }

  String command = commandNode["command"] | "";
  if (command == "CLEAR_WIFI") {
    Serial.println("Command received: clear WiFi and restart into setup mode.");
    preferences.putString("ssid", "");
    preferences.putString("pass", "");
    delay(500);
    ESP.restart();
  }

  if (command == "SET_WIFI") {
    String newSSID = commandNode["wifi_ssid"] | "";
    String newPass = commandNode["wifi_password"] | "";
    if (newSSID.length() == 0) {
      Serial.println("SET_WIFI command ignored: missing SSID.");
      return;
    }

    Serial.println("Command received: save new WiFi and restart.");
    preferences.putString("ssid", newSSID);
    preferences.putString("pass", newPass);
    delay(500);
    ESP.restart();
  }
}

