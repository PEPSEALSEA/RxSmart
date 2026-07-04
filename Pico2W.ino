#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <LittleFS.h>
#include <HTTPClient.h>
#include <HTTPUpdate.h>
#include <ArduinoJson.h>
#include <WiFiClientSecure.h>
#include <Wire.h>
#include <math.h>

// ---------------------------------------------------------
// Configuration / การตั้งค่าระบบ  (Raspberry Pi Pico 2 W / RP2350 build)
// ---------------------------------------------------------
const String CURRENT_VERSION = "1.0.0";
const String CLOUDFLARE_API_URL = "https://rxsmart-worker.sealseapep.workers.dev"; // URL ของ Cloudflare Workers

// ตั้งค่า AP & Captive Portal
const byte DNS_PORT = 53;
IPAddress apIP(192, 168, 4, 1);
DNSServer dnsServer;
WebServer server(80);

// ตัวแปรสำหรับเช็คการเชื่อมต่อ
unsigned long previousMillis = 0;
const long watchdogInterval = 60000; // ตรวจสอบอินเทอร์เน็ตทุกๆ 1 นาที

// External push-button used for "force AP mode / clear WiFi" — the Pico 2 W
// has no exposed BOOT-style GPIO button like the ESP32 DevKit, so we wire one
// ourselves. Button to GND, internal pull-up enabled, active LOW.
#define MODE_BUTTON_PIN 16
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

const bool USE_MPU6050_TEST = true; // keep TRUE on Pico 2 W — direct-analog fallback below is NOT usable (see notes)
const bool ENABLE_REALTIME_SERIAL_DEBUG = true;
const unsigned long SERIAL_DEBUG_INTERVAL_MS = 500;

// ---- I2C bus pins (Wire = I2C0 on RP2350) ----
// Primary bus: GP4 (SDA) / GP5 (SCL) -> TCA9548A -> 8x MPU6050
const uint8_t I2C_SDA_PIN = 4;
const uint8_t I2C_SCL_PIN = 5;
// Fallback bus if the mux isn't found on I2C0: use the second hardware I2C
// peripheral (Wire1 = I2C1) on GP6 (SDA) / GP7 (SCL) instead of rewiring.
const uint8_t I2C_SDA_FALLBACK_PIN = 6;
const uint8_t I2C_SCL_FALLBACK_PIN = 7;

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
  uint8_t pin; // TCA9548A channel index (0-7), NOT a GPIO on this board
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
  {"left_upper_arm", 0, 0, 0, 0, 0},
  {"right_upper_arm", 1, 0, 0, 0, 0},
  {"left_forearm", 2, 0, 0, 0, 0},
  {"right_forearm", 3, 0, 0, 0, 0},
  {"left_thigh", 4, 0, 0, 0, 0},
  {"right_thigh", 5, 0, 0, 0, 0},
  {"left_shin", 6, 0, 0, 0, 0},
  {"right_shin", 7, 0, 0, 0, 0}
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
TwoWire* activeWire = &Wire;
bool mpuPresent[SENSOR_COUNT] = {};
bool mpuReadOk[SENSOR_COUNT] = {};

const char* WIFI_CONFIG_PATH = "/wifi.json";
bool littleFsReady = false;

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
    body {
      font-family: 'Unica77 Cohere Web', Inter, Arial, ui-sans-serif, system-ui, sans-serif;
      background: #eeece7;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      color: #212121;
    }
    .card {
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 22px;
      padding: 40px 32px;
      width: 100%;
      max-width: 380px;
    }
    .eyebrow {
      font-family: 'CohereMono', Arial, ui-sans-serif, system-ui, monospace;
      font-size: 12px;
      letter-spacing: 0.28px;
      text-transform: uppercase;
      color: #93939f;
      margin-bottom: 10px;
    }
    h2 {
      font-size: 32px;
      font-weight: 400;
      letter-spacing: -0.32px;
      line-height: 1.2;
      color: #17171c;
      margin-bottom: 10px;
    }
    p.sub {
      font-size: 14px;
      line-height: 1.4;
      color: #75758a;
      margin-bottom: 28px;
    }
    label {
      font-size: 14px;
      color: #212121;
      display: block;
      margin-bottom: 6px;
      font-weight: 500;
    }
    input[type=text], input[type=password] {
      width: 100%;
      padding: 12px 14px;
      background: #ffffff;
      border: 1px solid #d9d9dd;
      border-radius: 8px;
      color: #17171c;
      font-size: 16px;
      font-family: inherit;
      margin-bottom: 20px;
      outline: none;
      transition: border-color 0.15s;
    }
    input[type=text]:focus, input[type=password]:focus { border-color: #9b60aa; }
    button {
      width: 100%;
      padding: 12px 24px;
      background: #17171c;
      border: none;
      border-radius: 9999px;
      color: #ffffff;
      font-size: 14px;
      font-weight: 500;
      letter-spacing: 0;
      cursor: pointer;
      transition: background 0.15s;
    }
    button:hover { background: #2c2c34; }
    button:disabled { background: #d9d9dd; color: #93939f; cursor: not-allowed; }
    #status { margin-top: 20px; padding: 12px 16px; border-radius: 8px; font-size: 14px; line-height: 1.4; display: none; }
    #status.checking { background: #f1f5ff; border: 1px solid #d9d9dd; color: #1863dc; display: block; }
    #status.success { background: #edfce9; border: 1px solid #d9d9dd; color: #003c33; display: block; }
    #status.error { background: #ffffff; border: 1px solid #ffad9b; color: #b30000; display: block; }
    .footnote { margin-top: 24px; font-size: 12px; color: #93939f; text-align: center; letter-spacing: 0.28px; text-transform: uppercase; font-family: 'CohereMono', Arial, ui-sans-serif, system-ui, monospace; }
  </style>
</head>
<body>
  <div class="card">
    <div class="eyebrow">Device Setup</div>
    <h2>RxSmart Setup</h2>
    <p class="sub">Enter your WiFi credentials to connect the board to the internet.</p>
    <form id="wifiForm">
      <label for="ssid">WiFi Name (SSID)</label>
      <input type="text" id="ssid" name="ssid" placeholder="e.g. MyHomeWiFi" required autocomplete="off">
      <label for="pass">Password</label>
      <input type="password" id="pass" name="pass" placeholder="Leave blank if open network" autocomplete="off">
      <button type="submit" id="btn">Save &amp; Connect</button>
    </form>
    <div id="status"></div>
    <div class="footnote">RxSmart Rehab Device</div>
  </div>
  <script>
    const form = document.getElementById('wifiForm');
    const btn  = document.getElementById('btn');
    const st   = document.getElementById('status');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      btn.disabled = true;
      st.className = 'checking';
      st.textContent = 'Saving...';
      const data = new URLSearchParams({ ssid: document.getElementById('ssid').value, pass: document.getElementById('pass').value });
      try {
        const res = await fetch('/save', { method: 'POST', body: data });
        const json = await res.json();
        if (json.success) {
          st.className = 'success';
          st.textContent = 'Saved. Board is restarting and will try to connect. If the password or network was wrong, the "RxSmart-Setup" hotspot will reappear in about 30 seconds \u2014 reconnect and try again.';
        } else {
          st.className = 'error';
          st.textContent = (json.error || 'Could not save. Please retry.');
          btn.disabled = false;
        }
      } catch(err) {
        st.className = 'error';
        st.textContent = 'Could not reach board. Try reloading.';
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
bool configureI2CForMPU(TwoWire& bus, uint8_t sdaPin, uint8_t sclPin);
void tcaSelect(uint8_t channel);
void tcaDisableAll();
bool loadWifiCredentials(String& ssidOut, String& passOut);
bool saveWifiCredentials(const String& ssid, const String& pass);
void clearWifiCredentials();
const char* resetReasonToString(RP2040::resetReason_t reason);

// ---------------------------------------------------------
// Setup Function
// ---------------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(1000);

  RP2040::resetReason_t bootReason = rp2040.getResetReason();
  Serial.printf("Reset reason code: %d (%s)\n", (int)bootReason, resetReasonToString(bootReason));

  // ระบบไฟล์ (LittleFS) ใช้เก็บ WiFi credentials แทน Preferences/NVS ของ ESP32
  littleFsReady = LittleFS.begin();
  if (!littleFsReady) {
    Serial.println("!!! LittleFS mount FAILED. WiFi credentials cannot be saved. !!!");
    Serial.println("!!! Fix: Arduino IDE -> Tools -> Flash Size -> pick an option");
    Serial.println("!!! that reserves space for a filesystem (e.g. 'Sketch: 1MB, FS: 1MB'),");
    Serial.println("!!! then re-upload. A 'no FS' flash layout cannot store settings.");
  }

  String savedSSID, savedPass;
  bool hasCreds = loadWifiCredentials(savedSSID, savedPass);

  Serial.println("\n--- Pico 2 W Booting ---");
  Serial.println("Current Version: " + CURRENT_VERSION);

  if (!hasCreds) {
    Serial.println("No WiFi credentials found. Starting Captive Portal.");
    inAPMode = true;
    setupAPMode();
    return;
  }

  // ---- ตรวจปุ่ม Mode: กดค้างตอน power-on เพื่อ force AP mode ----
  pinMode(MODE_BUTTON_PIN, INPUT_PULLUP);
  if (digitalRead(MODE_BUTTON_PIN) == LOW) {
    Serial.println("Mode button held – clearing WiFi and entering AP mode.");
    clearWifiCredentials();
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
      registerDevice();
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

    // กดปุ่ม Mode ค้าง 3 วินาทีขณะใช้งานปกติ (เมื่ออยู่ใน AP mode อยู่แล้วไม่ต้องทำอะไร)
  } else {
    if (sessionState == SESSION_EXERCISE && millis() - lastMotionSampleMs >= MOTION_SAMPLE_INTERVAL_MS) {
      updateMotionModel();
      lastMotionSampleMs = millis();
    } else if (sessionState != SESSION_EXERCISE && millis() - lastMotionSampleMs >= MOTION_SAMPLE_INTERVAL_MS) {
      sampleSensors(millis(), calibrationDone);
      lastMotionSampleMs = millis();
    }

    // ---- ตรวจปุ่ม Mode ขณะใช้งานปกติ (ต่อ WiFi สำเร็จ) ----
    static unsigned long bootPressStart = 0;
    if (digitalRead(MODE_BUTTON_PIN) == LOW) {
      if (bootPressStart == 0) bootPressStart = millis();
      if (millis() - bootPressStart >= 3000) {
        Serial.println("Mode button held 3s – clearing WiFi and restarting into AP mode.");
        clearWifiCredentials();
        delay(200);
        rp2040.restart();
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
        // clearWifiCredentials();
        rp2040.restart();
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
  if (setupComplete) {
    server.sendHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    server.send(200, "text/html", "<!doctype html><html><head><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>RxSmart Connected</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Unica77 Cohere Web',Inter,Arial,ui-sans-serif,system-ui,sans-serif;background:#eeece7;color:#212121;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}.card{max-width:380px;width:100%;background:#ffffff;border:1px solid #e5e7eb;border-radius:22px;padding:40px 32px;text-align:center}.eyebrow{font-family:'CohereMono',Arial,ui-sans-serif,system-ui,monospace;font-size:12px;letter-spacing:.28px;text-transform:uppercase;color:#93939f;margin-bottom:14px}h1{color:#003c33;background:#edfce9;display:inline-block;padding:6px 18px;border-radius:9999px;font-size:24px;font-weight:400;margin-bottom:18px}p{color:#75758a;line-height:1.5;font-size:14px}</style></head><body><div class=\"card\"><div class=\"eyebrow\">Device Setup</div><h1>Connected</h1><p>WiFi was saved successfully. This board is restarting and will register itself in the cloud dashboard automatically.</p></div></body></html>");
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

  // NOTE: unlike the ESP32 build, we do NOT test-connect to the target WiFi
  // while the setup hotspot is still running. On the Pico 2 W's CYW43 radio,
  // concurrent AP+STA mode reliably tears down the AP's DHCP/network layer
  // on older Arduino-Pico cores (<5.5.1), which disconnects the phone from
  // the portal mid-test ("Could not reach board"). Instead we save and
  // reboot; setup() already falls back to AP mode automatically if the
  // saved credentials don't work.
  Serial.println("[Setup] Saving WiFi: " + newSSID);
  if (!saveWifiCredentials(newSSID, newPass)) {
    String err = littleFsReady
      ? "Failed to write settings to flash. Please retry."
      : "Storage not available on this board (LittleFS not mounted). In Arduino IDE, set Tools > Flash Size to an option with a filesystem partition (e.g. Sketch 1MB / FS 1MB), then re-upload the firmware.";
    Serial.println("[Setup] Save failed: " + err);
    server.send(200, "application/json", "{\"success\":false,\"error\":\"" + err + "\"}");
    return;
  }

  setupComplete = true;
  server.send(200, "application/json", "{\"success\":true}");
  delay(1500);
  rp2040.restart();
}

// ---------------------------------------------------------
// WiFi Credential Storage (LittleFS replaces ESP32 Preferences/NVS)
// ---------------------------------------------------------
bool loadWifiCredentials(String& ssidOut, String& passOut) {
  if (!LittleFS.exists(WIFI_CONFIG_PATH)) return false;

  File f = LittleFS.open(WIFI_CONFIG_PATH, "r");
  if (!f) return false;

  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, f);
  f.close();
  if (err) return false;

  ssidOut = String((const char*)(doc["ssid"] | ""));
  passOut = String((const char*)(doc["pass"] | ""));
  return ssidOut.length() > 0;
}

bool saveWifiCredentials(const String& ssid, const String& pass) {
  if (!littleFsReady) {
    Serial.println("Cannot save WiFi credentials: LittleFS is not mounted (see Tools -> Flash Size).");
    return false;
  }

  File f = LittleFS.open(WIFI_CONFIG_PATH, "w");
  if (!f) {
    Serial.println("Failed to open LittleFS file for writing WiFi credentials.");
    return false;
  }
  JsonDocument doc;
  doc["ssid"] = ssid;
  doc["pass"] = pass;
  serializeJson(doc, f);
  f.close();

  // Verify the write actually landed on flash before trusting it.
  String checkSsid, checkPass;
  bool verified = loadWifiCredentials(checkSsid, checkPass) && checkSsid == ssid;
  if (!verified) {
    Serial.println("WiFi credentials failed verification after write.");
  }
  return verified;
}

void clearWifiCredentials() {
  if (LittleFS.exists(WIFI_CONFIG_PATH)) {
    LittleFS.remove(WIFI_CONFIG_PATH);
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
  String url = CLOUDFLARE_API_URL + "/api/firmware-version?platform=pico2w";

  http.begin(url);
  int httpCode = http.GET();

  if (httpCode == 200) {
    String payload = http.getString();

    // Parse JSON
    JsonDocument doc;
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

  JsonDocument doc;
  doc["schema_version"] = 2;
  doc["firmware_version"] = CURRENT_VERSION;
  doc["device_platform"] = "pico2w";
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

  JsonArray sensorArray = doc["sensors"].to<JsonArray>();
  for (size_t i = 0; i < SENSOR_COUNT; i++) {
    JsonObject s = sensorArray.add<JsonObject>();
    s["key"] = sensors[i].key;
    s["pin"] = sensors[i].pin;
    s["raw"] = sensors[i].raw;
    s["zero_offset"] = sensors[i].zeroOffset;
    s["calibrated"] = sensors[i].calibrated;
    s["timestamp_ms"] = sensors[i].timestampMs;
  }

  JsonObject angles = doc["angles"].to<JsonObject>();
  angles["elbow_left"] = motion.elbowLeft;
  angles["elbow_right"] = motion.elbowRight;
  angles["knee_left"] = motion.kneeLeft;
  angles["knee_right"] = motion.kneeRight;
  angles["primary"] = motion.primaryAngle;

  doc["speed_dps"] = motion.speedDegPerSec;
  doc["rep_count"] = motion.repCount;
  JsonObject posture = doc["posture"].to<JsonObject>();
  posture["state"] = motion.postureCorrect ? "correct" : "incorrect";
  posture["fault_mask"] = motion.postureFaultMask;
  posture["stability_score"] = motion.postureStabilityScore;

  JsonArray alerts = doc["alerts"].to<JsonArray>();
  if (motion.injuryAlertActive) {
    JsonObject alert = alerts.add<JsonObject>();
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

  JsonDocument doc;
  doc["device_id"] = getDeviceId();
  doc["device_platform"] = "pico2w";
  doc["wifi_ssid"] = WiFi.SSID();

  String jsonOutput;
  serializeJson(doc, jsonOutput);

  int httpCode = http.POST(jsonOutput);
  if (httpCode > 0) {
    Serial.printf("Device registration responded with code: %d\n", httpCode);
    Serial.println(http.getString());
  } else {
    Serial.printf("Device registration failed: %s\n", http.errorToString(httpCode).c_str());
  }

  http.end();
}

String getDeviceId() {
  return "PICO2W_" + WiFi.macAddress();
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

  JsonDocument doc;
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
    clearWifiCredentials();
    delay(500);
    rp2040.restart();
  }

  if (command == "SET_WIFI") {
    String newSSID = commandNode["wifi_ssid"] | "";
    String newPass = commandNode["wifi_password"] | "";
    if (newSSID.length() == 0) {
      Serial.println("SET_WIFI command ignored: missing SSID.");
      return;
    }

    Serial.println("Command received: save new WiFi and restart.");
    if (!saveWifiCredentials(newSSID, newPass)) {
      Serial.println("SET_WIFI command failed: could not persist credentials (LittleFS not mounted?).");
      return;
    }
    delay(500);
    rp2040.restart();
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
    bool configured = configureI2CForMPU(Wire, I2C_SDA_PIN, I2C_SCL_PIN);
    if (!configured) {
      configured = configureI2CForMPU(Wire1, I2C_SDA_FALLBACK_PIN, I2C_SCL_FALLBACK_PIN);
    }

    if (!configured) {
      Serial.println("TCA9548A not found on I2C0 (GP4/GP5) or I2C1 (GP6/GP7). Check wiring.");
    } else {
      uint8_t count = 0;
      for (uint8_t i = 0; i < SENSOR_COUNT; i++) if (mpuPresent[i]) count++;
      Serial.printf("TCA9548A ready on SDA=GP%u SCL=GP%u -> %u/8 MPU6050 found\n",
        activeI2CSdaPin, activeI2CSclPin, count);
      for (uint8_t i = 0; i < SENSOR_COUNT; i++) {
        Serial.printf("  CH%u [%-16s]: %s\n", i, sensors[i].key, mpuPresent[i] ? "OK" : "MISS");
      }
    }
    return;
  }

  // NOTE: direct-analog fallback is NOT viable on Pico 2 W — the board only
  // exposes 3 true ADC-capable GPIOs (GP26, GP27, GP28), not 8. Keep
  // USE_MPU6050_TEST = true and use the I2C mux + MPU6050 wiring instead.
  Serial.println("USE_MPU6050_TEST is false, but direct-analog mode needs 8 ADC pins which this board does not have. No sensors will be read.");
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

  // Direct-analog fallback disabled on this board — see initializeSensors().
  for (size_t i = 0; i < SENSOR_COUNT; i++) {
    sensors[i].raw = 0;
    sensors[i].calibrated = 0;
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
  activeWire->beginTransmission(address);
  activeWire->write(MPU6050_REG_PWR_MGMT_1);
  activeWire->write(0x00); // wake up MPU6050
  if (activeWire->endTransmission() != 0) {
    return false;
  }
  delay(10);
  return true;
}

bool readMPU6050Accel(uint8_t address, int16_t& ax, int16_t& ay, int16_t& az) {
  activeWire->beginTransmission(address);
  activeWire->write(MPU6050_REG_ACCEL_XOUT_H);
  if (activeWire->endTransmission(false) != 0) {
    return false;
  }

  int readBytes = activeWire->requestFrom((int)address, 6);
  if (readBytes != 6) {
    return false;
  }

  ax = (activeWire->read() << 8) | activeWire->read();
  ay = (activeWire->read() << 8) | activeWire->read();
  az = (activeWire->read() << 8) | activeWire->read();
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
  activeWire->beginTransmission(address);
  return activeWire->endTransmission() == 0;
}

bool configureI2CForMPU(TwoWire& bus, uint8_t sdaPin, uint8_t sclPin) {
  bus.setSDA(sdaPin);
  bus.setSCL(sclPin);
  bus.begin();
  bus.setClock(400000);
  delay(10);

  activeWire = &bus;

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
  activeWire->beginTransmission(TCA9548A_ADDR);
  activeWire->write(1 << channel);
  activeWire->endTransmission();
}

void tcaDisableAll() {
  activeWire->beginTransmission(TCA9548A_ADDR);
  activeWire->write(0x00);
  activeWire->endTransmission();
}

const char* resetReasonToString(RP2040::resetReason_t reason) {
  switch (reason) {
    case RP2040::UNKNOWN_RESET: return "UNKNOWN";
    case RP2040::PWRON_RESET: return "POWERON (first boot / power applied)";
    case RP2040::RUN_PIN_RESET: return "RUN_PIN (physical reset)";
    case RP2040::SOFT_RESET: return "SOFT (rp2040.restart()/reboot())";
    case RP2040::WDT_RESET: return "WATCHDOG";
    case RP2040::DEBUG_RESET: return "DEBUG_PORT";
    default: return "OTHER";
  }
}

void printRealtimeDebug(unsigned long nowMs) {
  Serial.printf(
    "[DBG] t=%lu state=%s cal=%d rep=%lu/%lu posture=%s speed=%.2f alert=%s code=%u i2c=GP%u/GP%u\n",
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
