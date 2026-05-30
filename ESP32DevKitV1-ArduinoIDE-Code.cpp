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

// ---------------------------------------------------------
// HTML สำหรับหน้า Captive Portal
// ---------------------------------------------------------
const char index_html[] PROGMEM = R"rawliteral(
<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ESP32 WiFi Setup</title>
  <style>
    body { font-family: Arial, sans-serif; text-align: center; margin-top: 50px; background-color: #f4f4f9; }
    h2 { color: #333; }
    form { display: inline-block; text-align: left; background: white; padding: 20px; border-radius: 8px; box-shadow: 0 4px 8px rgba(0,0,0,0.1); }
    input[type=text], input[type=password] { width: 100%; padding: 10px; margin: 10px 0; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box; }
    input[type=submit] { width: 100%; background-color: #4CAF50; color: white; padding: 14px 20px; margin: 8px 0; border: none; border-radius: 4px; cursor: pointer; }
    input[type=submit]:hover { background-color: #45a049; }
  </style>
</head>
<body>
  <h2>ESP32 Smart Setup</h2>
  <form action="/save" method="POST">
    <label for="ssid">WiFi Name (SSID):</label>
    <input type="text" id="ssid" name="ssid" required>
    <label for="pass">Password:</label>
    <input type="password" id="pass" name="pass">
    <input type="submit" value="Save & Restart">
  </form>
</body>
</html>
)rawliteral";

// ---------------------------------------------------------
// Function Declarations
// ---------------------------------------------------------
void setupAPMode();
void handleRoot();
void handleSave();
bool checkInternetWatchdog();
void checkFirmwareUpdate();
void sendTelemetryData();

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
    setupAPMode();
  } else {
    Serial.print("Attempting to connect to: ");
    Serial.println(savedSSID);
    
    WiFi.mode(WIFI_STA);
    WiFi.begin(savedSSID.c_str(), savedPass.c_str());

    int attempts = 0;
    while (WiFi.status() != WL_CONNECTED && attempts < 30) { // รอ 30 วินาที
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
      } else {
        Serial.println("WiFi connected but NO INTERNET. Starting Captive Portal.");
        setupAPMode();
      }
    } else {
      Serial.println("\nFailed to connect. Starting Captive Portal.");
      setupAPMode();
    }
  }
}

// ---------------------------------------------------------
// Loop Function
// ---------------------------------------------------------
void loop() {
  if (WiFi.getMode() == WIFI_AP) {
    dnsServer.processNextRequest();
    server.handleClient();
  } else {
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
      }
    }
  }
}

// ---------------------------------------------------------
// Functions สำหรับ Captive Portal
// ---------------------------------------------------------
void setupAPMode() {
  WiFi.mode(WIFI_AP);
  WiFi.softAPConfig(apIP, apIP, IPAddress(255, 255, 255, 0));
  WiFi.softAP("RxSmart-Setup"); // ชื่อ WiFi สำหรับตั้งค่า
  
  // ตั้งค่า DNS ให้ redirect ทุกอย่างมาที่ IP ของบอร์ด (Captive Portal)
  dnsServer.start(DNS_PORT, "*", apIP);
  
  // Web Server Routes
  server.on("/", HTTP_GET, handleRoot);
  server.on("/save", HTTP_POST, handleSave);
  // Captive Portal Redirect
  server.onNotFound([]() {
    server.sendHeader("Location", String("http://") + apIP.toString(), true);
    server.send(302, "text/plain", "");
  });
  
  server.begin();
  Serial.println("AP Mode started. Connect to 'RxSmart-Setup' to configure WiFi.");
}

void handleRoot() {
  server.send(200, "text/html", index_html);
}

void handleSave() {
  if (server.hasArg("ssid")) {
    String newSSID = server.arg("ssid");
    String newPass = server.hasArg("pass") ? server.arg("pass") : "";
    
    // บันทึกค่าลง Preferences
    preferences.putString("ssid", newSSID);
    preferences.putString("pass", newPass);
    
    server.send(200, "text/html", "<h2>Settings Saved! Rebooting...</h2>");
    delay(2000);
    ESP.restart(); // รีสตาร์ทเพื่อให้ต่อ WiFi ใหม่
  } else {
    server.send(400, "text/plain", "Error: SSID missing.");
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
  doc["device_id"] = "ESP32_" + WiFi.macAddress();
  // สมมติค่า Sensor (สามารถเปลี่ยนเป็นการอ่านค่าจาก Sensor จริงๆ ได้)
  doc["sensor_value"] = random(20, 40); 
  doc["status"] = "Active";
  
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
