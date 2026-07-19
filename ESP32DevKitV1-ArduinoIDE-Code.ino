#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <Preferences.h>
#include <HTTPClient.h>
#include <HTTPUpdate.h>
#include <ArduinoJson.h>
#include <WiFiClientSecure.h>
#include <Wire.h>
#include <math.h>
#include <esp_system.h>

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
bool setupComplete = false;

const size_t SENSOR_COUNT = 8;
const unsigned long MOTION_SAMPLE_INTERVAL_MS = 50;
const unsigned long CALIBRATION_WINDOW_MS = 3000;
const float RAW_TO_DEGREE = 360.0f / 4095.0f;
const float REP_UP_THRESHOLD = 65.0f;
const float REP_DOWN_THRESHOLD = 25.0f;
const float SAFE_MAX_JOINT_ANGLE = 165.0f;
const float SAFE_MAX_SPEED_DPS = 220.0f;
const int POSTURE_STABILITY_MAX = 5;
const int POSTURE_STABILITY_MIN = -5;

const uint16_t POSTURE_FAULT_ELBOW_SYMMETRY = 1 << 0;
const uint16_t POSTURE_FAULT_KNEE_SYMMETRY = 1 << 1;
const uint16_t POSTURE_FAULT_ELBOW_RANGE = 1 << 2;
const uint16_t POSTURE_FAULT_KNEE_RANGE = 1 << 3;

const uint16_t ALERT_CODE_JOINT_ANGLE = 1 << 0;
const uint16_t ALERT_CODE_SPEED = 1 << 1;

const bool USE_MPU6050_TEST = true;
const bool ENABLE_REALTIME_SERIAL_DEBUG = true;
const unsigned long SERIAL_DEBUG_INTERVAL_MS = 500;
const uint8_t I2C_SDA_PIN = 21;
const uint8_t I2C_SDA_FALLBACK_PIN = 23;
const uint8_t I2C_SCL_PIN = 22;
const uint8_t TCA9548A_ADDR = 0x70;             // A0=A1=A2=GND
const uint8_t MPU6050_ADDR = 0x68;              // AD0 -> GND (ทุกตัว)
const uint8_t MPU6050_REG_PWR_MGMT_1 = 0x6B;
const uint8_t MPU6050_REG_ACCEL_XOUT_H = 0x3B;

enum SessionState {
  SESSION_IDLE,
  SESSION_CALIBRATE,
  SESSION_EXERCISE,
  SESSION_COMPLETE
};

struct SensorDataPoint {
  const char* key;
  uint8_t pin;
  float raw;
  float zeroOffset;
  float calibrated;
  unsigned long timestampMs;
};

struct MotionMetrics {
  float elbowLeft;
  float elbowRight;
  float kneeLeft;
  float kneeRight;
  float primaryAngle;
  float speedDegPerSec;
  bool postureCorrect;
  unsigned long repCount;
  uint16_t postureFaultMask;
  int postureStabilityScore;
  bool injuryAlertActive;
  const char* injuryAlertLevel;
  uint16_t injuryAlertCode;
};

SensorDataPoint sensors[SENSOR_COUNT] = {
  {"left_upper_arm", 36, 0, 0, 0, 0},
  {"right_upper_arm", 39, 0, 0, 0, 0},
  {"left_forearm", 34, 0, 0, 0, 0},
  {"right_forearm", 35, 0, 0, 0, 0},
  {"left_thigh", 32, 0, 0, 0, 0},
  {"right_thigh", 33, 0, 0, 0, 0},
  {"left_shin", 27, 0, 0, 0, 0},
  {"right_shin", 14, 0, 0, 0, 0}
};

MotionMetrics motion = {0, 0, 0, 0, 0, 0, true, 0, 0, 0, false, "none", 0};
bool calibrationDone = false;
bool repPeakReached = false;
unsigned long lastMotionSampleMs = 0;
unsigned long lastMotionUpdateMs = 0;
float prevPrimaryAngle = 0.0f;
SessionState sessionState = SESSION_IDLE;
String sessionId = "";
String exerciseId = "general";
unsigned long sessionStartedMs = 0;
unsigned long sessionCompletedMs = 0;
unsigned long repTarget = 10;
bool sessionSummaryPending = false;
unsigned long lastSerialDebugMs = 0;
uint8_t activeI2CSdaPin = I2C_SDA_PIN;
uint8_t activeI2CSclPin = I2C_SCL_PIN;
bool mpuPresent[SENSOR_COUNT] = {};
bool mpuReadOk[SENSOR_COUNT] = {};

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
void registerDevice();
void ensureDeviceRegistered();
void sendTelemetryData();
void checkDeviceCommand();
String getDeviceId();
String urlEncode(const String& value);
void initializeSensors();
void runCalibration();
void sampleSensors(unsigned long nowMs, bool applyCalibration);
void updateMotionModel();
float sensorToDegrees(float sensorValue);
void updateRepCounter(float angleValue);
uint16_t evaluatePostureFaults(float elbowLeft, float elbowRight, float kneeLeft, float kneeRight);
void updatePostureStability(bool postureCorrect);
void updateInjuryAlert();
void startSession(const String& nextExerciseId, unsigned long nextRepTarget);
void completeSession(const char* reason);
const char* sessionStateToString(SessionState state);
String buildSessionId();
float clampAngle(float value);
bool initMPU6050(uint8_t address);
bool readMPU6050Accel(uint8_t address, int16_t& ax, int16_t& ay, int16_t& az);
float accelToPseudoRaw(int16_t ax, int16_t ay, int16_t az);
void printRealtimeDebug(unsigned long nowMs);
bool probeI2CAddress(uint8_t address);
bool configureI2CForMPU(uint8_t sdaPin, uint8_t sclPin);
void tcaSelect(uint8_t channel);
void tcaDisableAll();

// ---------------------------------------------------------
// Setup Function
// ---------------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(1000);

  esp_reset_reason_t bootReason = esp_reset_reason();
  Serial.printf("Reset reason code: %d\n", (int)bootReason);
  switch (bootReason) {
    case ESP_RST_BROWNOUT: Serial.println("Reset reason: BROWNOUT (power supply dropped too low)"); break;
    case ESP_RST_PANIC: Serial.println("Reset reason: PANIC (crash/exception)"); break;
    case ESP_RST_INT_WDT: Serial.println("Reset reason: INT_WDT (interrupt watchdog)"); break;
    case ESP_RST_TASK_WDT: Serial.println("Reset reason: TASK_WDT (task watchdog)"); break;
    case ESP_RST_WDT: Serial.println("Reset reason: WDT (other watchdog)"); break;
    case ESP_RST_POWERON: Serial.println("Reset reason: POWERON (first boot / power applied)"); break;
    case ESP_RST_SW: Serial.println("Reset reason: SW (software restart)"); break;
    default: Serial.printf("Reset reason: OTHER (%d)\n", (int)bootReason); break;
  }

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
        initializeSensors();
        sampleSensors(millis(), false);
        ensureDeviceRegistered();
        sendTelemetryData();
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
    if (sessionState == SESSION_EXERCISE && millis() - lastMotionSampleMs >= MOTION_SAMPLE_INTERVAL_MS) {
      updateMotionModel();
      lastMotionSampleMs = millis();
    } else if (sessionState != SESSION_EXERCISE && millis() - lastMotionSampleMs >= MOTION_SAMPLE_INTERVAL_MS) {
      sampleSensors(millis(), calibrationDone);
      lastMotionSampleMs = millis();
    }

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
        if (sessionState == SESSION_COMPLETE && sessionSummaryPending) {
          sendTelemetryData();
          sessionSummaryPending = false;
          sessionState = SESSION_IDLE;
        }
        // ถ้าเน็ตปกติ ให้ส่งข้อมูล (Telemetry)
        sendTelemetryData();
        checkDeviceCommand();
      }
    }

    if (ENABLE_REALTIME_SERIAL_DEBUG && currentMillis - lastSerialDebugMs >= SERIAL_DEBUG_INTERVAL_MS) {
      lastSerialDebugMs = currentMillis;
      printRealtimeDebug(currentMillis);
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
  WiFi.setTxPower(WIFI_POWER_8_5dBm); // lower RF inrush current to reduce brownout risk
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
  if (setupComplete) {
    server.sendHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    server.send(200, "text/html", "<!doctype html><html><head><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>RxSmart Connected</title><style>body{font-family:Arial,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh;display:flex;align-items:center;justify-content:center;margin:0}.card{max-width:340px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.15);border-radius:18px;padding:28px;text-align:center}h1{color:#4ade80;font-size:24px}p{color:#94a3b8;line-height:1.5}</style></head><body><div class=\"card\"><h1>Connected</h1><p>WiFi was saved successfully. This board is restarting and will register itself in the cloud dashboard automatically.</p></div></body></html>");
    return;
  }

  server.sendHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  server.sendHeader("Pragma", "no-cache");
  server.sendHeader("Expires", "0");
  server.sendHeader("Location", "http://192.168.4.1", true);
  server.send(200, "text/html", index_html);
}

void handleSave() {
  if (setupComplete) {
    server.send(409, "application/json", "{\"success\":false,\"error\":\"WiFi is already connected and saved.\"}");
    return;
  }

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
    setupComplete = true;
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
  String url = CLOUDFLARE_API_URL + "/api/firmware-version?platform=esp32";
  
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
  
  sampleSensors(millis(), calibrationDone);

  StaticJsonDocument<3072> doc;
  doc["schema_version"] = 2;
  doc["firmware_version"] = CURRENT_VERSION;
  doc["device_platform"] = "esp32";
  doc["device_ts_ms"] = millis();
  doc["device_id"] = getDeviceId();
  doc["status"] = sessionState == SESSION_EXERCISE ? "Active" : "Idle";
  doc["wifi_ssid"] = WiFi.SSID();
  doc["calibrated"] = calibrationDone;
  doc["session_id"] = sessionId;
  doc["session_state"] = sessionStateToString(sessionState);
  doc["exercise_id"] = exerciseId;
  doc["session_started_ms"] = sessionStartedMs;
  doc["session_completed_ms"] = sessionCompletedMs;
  doc["rep_target"] = repTarget;
  doc["summary_pending"] = sessionSummaryPending;

  JsonArray sensorArray = doc.createNestedArray("sensors");
  for (size_t i = 0; i < SENSOR_COUNT; i++) {
    JsonObject s = sensorArray.createNestedObject();
    s["key"] = sensors[i].key;
    s["pin"] = sensors[i].pin;
    s["raw"] = sensors[i].raw;
    s["zero_offset"] = sensors[i].zeroOffset;
    s["calibrated"] = sensors[i].calibrated;
    s["timestamp_ms"] = sensors[i].timestampMs;
  }

  JsonObject angles = doc.createNestedObject("angles");
  angles["elbow_left"] = motion.elbowLeft;
  angles["elbow_right"] = motion.elbowRight;
  angles["knee_left"] = motion.kneeLeft;
  angles["knee_right"] = motion.kneeRight;
  angles["primary"] = motion.primaryAngle;

  doc["speed_dps"] = motion.speedDegPerSec;
  doc["rep_count"] = motion.repCount;
  JsonObject posture = doc.createNestedObject("posture");
  posture["state"] = motion.postureCorrect ? "correct" : "incorrect";
  posture["fault_mask"] = motion.postureFaultMask;
  posture["stability_score"] = motion.postureStabilityScore;

  JsonArray alerts = doc.createNestedArray("alerts");
  if (motion.injuryAlertActive) {
    JsonObject alert = alerts.createNestedObject();
    alert["level"] = motion.injuryAlertLevel;
    alert["code"] = motion.injuryAlertCode;
  }
  
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

void registerDevice() {
  if (WiFi.status() != WL_CONNECTED) return;

  Serial.println("Registering device...");
  HTTPClient http;
  String url = CLOUDFLARE_API_URL + "/api/devices/register";

  http.begin(url);
  http.addHeader("Content-Type", "application/json");

  StaticJsonDocument<256> doc;
  doc["device_id"] = getDeviceId();
  doc["device_platform"] = "esp32";
  doc["wifi_ssid"] = WiFi.SSID();

  String jsonOutput;
  serializeJson(doc, jsonOutput);

  int httpCode = http.POST(jsonOutput);
  if (httpCode > 0) {
    String response = http.getString();
    Serial.printf("Device registration responded with code: %d\n", httpCode);
    Serial.println(response);

    StaticJsonDocument<256> responseDoc;
    if (!deserializeJson(responseDoc, response)) {
      bool created = responseDoc["created"] | false;
      bool existsBefore = responseDoc["exists_before"] | false;
      if (created) {
        Serial.println("Cloudflare: added new device row to Devices sheet.");
      } else if (existsBefore) {
        Serial.println("Cloudflare: device row already existed and was refreshed.");
      }
    }
  } else {
    Serial.printf("Device registration failed: %s\n", http.errorToString(httpCode).c_str());
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

void ensureDeviceRegistered() {
  if (WiFi.status() != WL_CONNECTED) return;

  Serial.println("Checking Devices sheet on Cloudflare...");
  HTTPClient http;
  String deviceId = getDeviceId();
  String checkUrl = CLOUDFLARE_API_URL + "/api/devices/" + urlEncode(deviceId) + "/check";
  http.begin(checkUrl);
  int checkCode = http.GET();

  bool exists = false;
  if (checkCode == 200) {
    StaticJsonDocument<256> doc;
    DeserializationError error = deserializeJson(doc, http.getString());
    if (!error) {
      exists = doc["exists"] | false;
    } else {
      Serial.println("Failed to parse device check response.");
    }
  } else {
    Serial.printf("Device check failed, HTTP error: %d\n", checkCode);
  }
  http.end();

  if (exists) {
    Serial.println("Device already registered in Devices sheet.");
    return;
  }

  if (checkCode == 200) {
    Serial.println("Device not found in Devices sheet — registering as new...");
  } else {
    Serial.println("Could not confirm registry status — attempting register anyway...");
  }
  registerDevice();
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

  if (command == "START_SESSION") {
    String nextExerciseId = commandNode["exercise_id"] | "general";
    unsigned long nextRepTarget = commandNode["rep_target"] | 10;
    startSession(nextExerciseId, nextRepTarget);
  }

  if (command == "END_SESSION") {
    completeSession("remote_command");
  }

  if (command == "RECALIBRATE") {
    Serial.println("Command received: recalibrate sensors.");
    SessionState prevState = sessionState;
    sessionState = SESSION_CALIBRATE;
    runCalibration();
    sessionState = (prevState == SESSION_EXERCISE) ? SESSION_EXERCISE : SESSION_IDLE;
  }
}

void initializeSensors() {
  if (USE_MPU6050_TEST) {
    bool configured = configureI2CForMPU(I2C_SDA_PIN, I2C_SCL_PIN);
    if (!configured && I2C_SDA_FALLBACK_PIN != I2C_SDA_PIN) {
      configured = configureI2CForMPU(I2C_SDA_FALLBACK_PIN, I2C_SCL_PIN);
    }

    if (!configured) {
      Serial.println("TCA9548A not found on SDA21/SDA23 + SCL22. Check wiring.");
    } else {
      uint8_t count = 0;
      for (uint8_t i = 0; i < SENSOR_COUNT; i++) if (mpuPresent[i]) count++;
      Serial.printf("TCA9548A ready on SDA=%u SCL=%u -> %u/8 MPU6050 found\n",
        activeI2CSdaPin, activeI2CSclPin, count);
      for (uint8_t i = 0; i < SENSOR_COUNT; i++) {
        Serial.printf("  CH%u [%-16s]: %s\n", i, sensors[i].key, mpuPresent[i] ? "OK" : "MISS");
      }
    }
    return;
  }

  analogReadResolution(12);
  analogSetAttenuation(ADC_11db);
  for (size_t i = 0; i < SENSOR_COUNT; i++) {
    pinMode(sensors[i].pin, INPUT);
  }
}

void runCalibration() {
  Serial.println("Calibration started: keep standing in reference posture.");
  const unsigned long startMs = millis();
  unsigned long sampleCount = 0;
  float sums[SENSOR_COUNT] = {0};

  while (millis() - startMs < CALIBRATION_WINDOW_MS) {
    sampleSensors(millis(), false);
    for (size_t i = 0; i < SENSOR_COUNT; i++) {
      sums[i] += sensors[i].raw;
    }
    sampleCount++;
    delay(20);
  }

  if (sampleCount == 0) sampleCount = 1;

  for (size_t i = 0; i < SENSOR_COUNT; i++) {
    sensors[i].zeroOffset = sums[i] / sampleCount;
    sensors[i].calibrated = 0;
  }

  calibrationDone = true;
  repPeakReached = false;
  motion.repCount = 0;
  motion.postureFaultMask = 0;
  motion.postureStabilityScore = 0;
  motion.injuryAlertActive = false;
  motion.injuryAlertLevel = "none";
  motion.injuryAlertCode = 0;
  lastMotionUpdateMs = millis();
  prevPrimaryAngle = 0.0f;
  Serial.println("Calibration complete.");
}

void sampleSensors(unsigned long nowMs, bool applyCalibration) {
  if (USE_MPU6050_TEST) {
    for (size_t i = 0; i < SENSOR_COUNT; i++) {
      int16_t ax = 0, ay = 0, az = 0;
      if (mpuPresent[i]) {
        tcaSelect(i);
        mpuReadOk[i] = readMPU6050Accel(MPU6050_ADDR, ax, ay, az);
      } else {
        mpuReadOk[i] = false;
      }
      float raw = mpuReadOk[i] ? accelToPseudoRaw(ax, ay, az) : 0.0f;
      sensors[i].raw = raw;
      sensors[i].calibrated = applyCalibration ? (raw - sensors[i].zeroOffset) : raw;
      sensors[i].timestampMs = nowMs;
    }
    tcaDisableAll();
    return;
  }

  for (size_t i = 0; i < SENSOR_COUNT; i++) {
    sensors[i].raw = analogRead(sensors[i].pin);
    sensors[i].calibrated = applyCalibration ? (sensors[i].raw - sensors[i].zeroOffset) : sensors[i].raw;
    sensors[i].timestampMs = nowMs;
  }
}

float sensorToDegrees(float sensorValue) {
  return sensorValue * RAW_TO_DEGREE;
}

uint16_t evaluatePostureFaults(float elbowLeft, float elbowRight, float kneeLeft, float kneeRight) {
  uint16_t faultMask = 0;
  if (fabs(elbowLeft - elbowRight) > 20.0f) faultMask |= POSTURE_FAULT_ELBOW_SYMMETRY;
  if (fabs(kneeLeft - kneeRight) > 20.0f) faultMask |= POSTURE_FAULT_KNEE_SYMMETRY;
  if (!(elbowLeft >= 0 && elbowLeft <= 170 && elbowRight >= 0 && elbowRight <= 170)) faultMask |= POSTURE_FAULT_ELBOW_RANGE;
  if (!(kneeLeft >= 0 && kneeLeft <= 170 && kneeRight >= 0 && kneeRight <= 170)) faultMask |= POSTURE_FAULT_KNEE_RANGE;
  return faultMask;
}

void updatePostureStability(bool postureCorrect) {
  if (postureCorrect) {
    motion.postureStabilityScore = min(POSTURE_STABILITY_MAX, motion.postureStabilityScore + 1);
  } else {
    motion.postureStabilityScore = max(POSTURE_STABILITY_MIN, motion.postureStabilityScore - 1);
  }
}

void updateInjuryAlert() {
  uint16_t alertCode = 0;
  if (motion.elbowLeft > SAFE_MAX_JOINT_ANGLE || motion.elbowRight > SAFE_MAX_JOINT_ANGLE ||
      motion.kneeLeft > SAFE_MAX_JOINT_ANGLE || motion.kneeRight > SAFE_MAX_JOINT_ANGLE) {
    alertCode |= ALERT_CODE_JOINT_ANGLE;
  }
  if (motion.speedDegPerSec > SAFE_MAX_SPEED_DPS) {
    alertCode |= ALERT_CODE_SPEED;
  }

  motion.injuryAlertCode = alertCode;
  motion.injuryAlertActive = alertCode != 0;
  if (alertCode & ALERT_CODE_SPEED) {
    motion.injuryAlertLevel = "critical";
  } else if (alertCode != 0) {
    motion.injuryAlertLevel = "warn";
  } else {
    motion.injuryAlertLevel = "none";
  }
}

void updateRepCounter(float angleValue) {
  if (!repPeakReached && angleValue >= REP_UP_THRESHOLD) {
    repPeakReached = true;
  }
  if (repPeakReached && angleValue <= REP_DOWN_THRESHOLD) {
    motion.repCount++;
    repPeakReached = false;
  }
}

void updateMotionModel() {
  if (!calibrationDone || sessionState != SESSION_EXERCISE) return;

  const unsigned long nowMs = millis();
  sampleSensors(nowMs, true);

  float leftUpperArmDeg = sensorToDegrees(sensors[0].calibrated);
  float rightUpperArmDeg = sensorToDegrees(sensors[1].calibrated);
  float leftForearmDeg = sensorToDegrees(sensors[2].calibrated);
  float rightForearmDeg = sensorToDegrees(sensors[3].calibrated);
  float leftThighDeg = sensorToDegrees(sensors[4].calibrated);
  float rightThighDeg = sensorToDegrees(sensors[5].calibrated);
  float leftShinDeg = sensorToDegrees(sensors[6].calibrated);
  float rightShinDeg = sensorToDegrees(sensors[7].calibrated);

  motion.elbowLeft = clampAngle(fabs(leftForearmDeg - leftUpperArmDeg));
  motion.elbowRight = clampAngle(fabs(rightForearmDeg - rightUpperArmDeg));
  motion.kneeLeft = clampAngle(fabs(leftShinDeg - leftThighDeg));
  motion.kneeRight = clampAngle(fabs(rightShinDeg - rightThighDeg));
  motion.primaryAngle = (motion.elbowLeft + motion.elbowRight + motion.kneeLeft + motion.kneeRight) / 4.0f;

  float dtSec = (nowMs - lastMotionUpdateMs) / 1000.0f;
  if (dtSec > 0.0f) {
    motion.speedDegPerSec = fabs(motion.primaryAngle - prevPrimaryAngle) / dtSec;
  } else {
    motion.speedDegPerSec = 0.0f;
  }

  motion.postureFaultMask = evaluatePostureFaults(motion.elbowLeft, motion.elbowRight, motion.kneeLeft, motion.kneeRight);
  motion.postureCorrect = motion.postureFaultMask == 0;
  updatePostureStability(motion.postureCorrect);
  updateInjuryAlert();
  updateRepCounter(motion.primaryAngle);
  if (repTarget > 0 && motion.repCount >= repTarget) {
    completeSession("rep_target_reached");
  }
  prevPrimaryAngle = motion.primaryAngle;
  lastMotionUpdateMs = nowMs;
}

void startSession(const String& nextExerciseId, unsigned long nextRepTarget) {
  if (sessionState == SESSION_EXERCISE) {
    completeSession("replaced_by_new_session");
  }

  exerciseId = nextExerciseId.length() > 0 ? nextExerciseId : "general";
  repTarget = nextRepTarget > 0 ? nextRepTarget : 10;
  sessionId = buildSessionId();
  sessionStartedMs = millis();
  sessionCompletedMs = 0;
  sessionSummaryPending = false;
  sessionState = SESSION_CALIBRATE;
  runCalibration();
  sessionState = SESSION_EXERCISE;
}

void completeSession(const char* reason) {
  if (sessionState != SESSION_EXERCISE) return;
  sessionState = SESSION_COMPLETE;
  sessionCompletedMs = millis();
  sessionSummaryPending = true;
  Serial.print("Session complete: ");
  Serial.println(reason);
}

const char* sessionStateToString(SessionState state) {
  switch (state) {
    case SESSION_IDLE:
      return "idle";
    case SESSION_CALIBRATE:
      return "calibrate";
    case SESSION_EXERCISE:
      return "exercise";
    case SESSION_COMPLETE:
      return "complete";
  }
  return "idle";
}

String buildSessionId() {
  String base = getDeviceId();
  base.replace(":", "");
  return base + "_" + String(millis());
}

float clampAngle(float value) {
  if (value < 0.0f) return 0.0f;
  if (value > 180.0f) return 180.0f;
  return value;
}

bool initMPU6050(uint8_t address) {
  Wire.beginTransmission(address);
  Wire.write(MPU6050_REG_PWR_MGMT_1);
  Wire.write(0x00); // wake up MPU6050
  if (Wire.endTransmission() != 0) {
    return false;
  }
  delay(10);
  return true;
}

bool readMPU6050Accel(uint8_t address, int16_t& ax, int16_t& ay, int16_t& az) {
  Wire.beginTransmission(address);
  Wire.write(MPU6050_REG_ACCEL_XOUT_H);
  if (Wire.endTransmission(false) != 0) {
    return false;
  }

  int readBytes = Wire.requestFrom((int)address, 6);
  if (readBytes != 6) {
    return false;
  }

  ax = (Wire.read() << 8) | Wire.read();
  ay = (Wire.read() << 8) | Wire.read();
  az = (Wire.read() << 8) | Wire.read();
  return true;
}

float accelToPseudoRaw(int16_t ax, int16_t ay, int16_t az) {
  float fx = (float)ax;
  float fy = (float)ay;
  float fz = (float)az;

  // use pitch angle from accelerometer as a quick test signal
  float pitchDeg = atan2f(fx, sqrtf(fy * fy + fz * fz)) * 180.0f / PI;
  float angle0to180 = constrain(pitchDeg + 90.0f, 0.0f, 180.0f);
  return angle0to180 * (4095.0f / 360.0f); // keep compatible with sensorToDegrees()
}

bool probeI2CAddress(uint8_t address) {
  Wire.beginTransmission(address);
  return Wire.endTransmission() == 0;
}

bool configureI2CForMPU(uint8_t sdaPin, uint8_t sclPin) {
  Wire.begin(sdaPin, sclPin);
  Wire.setClock(400000);
  delay(10);

  if (!probeI2CAddress(TCA9548A_ADDR)) return false;

  bool anyFound = false;
  for (uint8_t ch = 0; ch < SENSOR_COUNT; ch++) {
    tcaSelect(ch);
    delay(2);
    bool found = probeI2CAddress(MPU6050_ADDR);
    mpuPresent[ch] = found && initMPU6050(MPU6050_ADDR);
    if (mpuPresent[ch]) anyFound = true;
  }
  tcaDisableAll();

  if (anyFound) {
    activeI2CSdaPin = sdaPin;
    activeI2CSclPin = sclPin;
  }
  return anyFound;
}

void tcaSelect(uint8_t channel) {
  if (channel > 7) return;
  Wire.beginTransmission(TCA9548A_ADDR);
  Wire.write(1 << channel);
  Wire.endTransmission();
}

void tcaDisableAll() {
  Wire.beginTransmission(TCA9548A_ADDR);
  Wire.write(0x00);
  Wire.endTransmission();
}

void printRealtimeDebug(unsigned long nowMs) {
  Serial.printf(
    "[DBG] t=%lu state=%s cal=%d rep=%lu/%lu posture=%s speed=%.2f alert=%s code=%u i2c=%u/%u\n",
    nowMs,
    sessionStateToString(sessionState),
    calibrationDone ? 1 : 0,
    motion.repCount,
    repTarget,
    motion.postureCorrect ? "ok" : "bad",
    motion.speedDegPerSec,
    motion.injuryAlertLevel,
    motion.injuryAlertCode,
    activeI2CSdaPin,
    activeI2CSclPin
  );
  Serial.printf("  angles: elbowL=%.1f elbowR=%.1f kneeL=%.1f kneeR=%.1f\n",
    motion.elbowLeft, motion.elbowRight, motion.kneeLeft, motion.kneeRight);
  for (uint8_t i = 0; i < SENSOR_COUNT; i++) {
    Serial.printf("  CH%u [%-16s] raw=%.1f cal=%.1f %s\n",
      i, sensors[i].key, sensors[i].raw, sensors[i].calibrated,
      mpuReadOk[i] ? "OK" : (mpuPresent[i] ? "ERR" : "NA"));
  }
}

