// =============================================================================
// firmware_local_server_snippet.ino
// =============================================================================
// โค้ดที่ต้องเพิ่มเข้าไปใน ESP32DevKitV1-ArduinoIDE-Code.ino
// เพื่อให้ ESP32 ส่งข้อมูล real-time ไปยัง Python server บนคอมพิวเตอร์
// ผ่าน WiFi โดยตรง — ไม่ต้องต่อสาย USB
//
// วิธีใช้:
//   1. รัน Python pipeline ก่อน: python main.py  (ตั้ง IOT_TRANSPORT = "server")
//   2. ดู IP ที่แสดงในหน้าต่าง Terminal เช่น  http://192.168.1.5:8765/telemetry
//   3. แก้ LOCAL_SERVER_URL ด้านล่างให้ตรงกับ IP ของคอมพิวเตอร์
//   4. Paste โค้ดส่วนที่ระบุลงในไฟล์ .ino หลัก แล้ว Upload
// =============================================================================

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1: เพิ่มค่าคงที่เหล่านี้ต่อจากบรรทัด  const String CLOUDFLARE_API_URL = ...
// ─────────────────────────────────────────────────────────────────────────────

// แก้ IP ให้ตรงกับ IP ของเครื่องคอมพิวเตอร์ที่รัน Python
// วิธีหา IP: Windows → cmd → ipconfig → หา "IPv4 Address" ใต้ WiFi adapter
const String LOCAL_SERVER_URL = "http://192.168.x.x:8765";  // <-- แก้ตรงนี้

// ส่งไปยัง Python ทุก 500 ms (เท่ากับ SERIAL_DEBUG_INTERVAL_MS)
const unsigned long LOCAL_SERVER_INTERVAL_MS = 500;
bool localServerEnabled = true;  // ตั้งเป็น false เพื่อปิดโดยไม่ต้องแก้โค้ดอื่น

unsigned long lastLocalServerMs = 0;  // timer variable (เพิ่มหลัง lastSerialDebugMs)


// ─────────────────────────────────────────────────────────────────────────────
// STEP 2: เพิ่ม function declaration ในส่วน "Function Declarations"
// ─────────────────────────────────────────────────────────────────────────────
void sendToLocalServer();


// ─────────────────────────────────────────────────────────────────────────────
// STEP 3: เพิ่มโค้ดนี้ใน loop() ต่อจากบล็อก printRealtimeDebug
// ─────────────────────────────────────────────────────────────────────────────
/*
    if (localServerEnabled && WiFi.status() == WL_CONNECTED) {
      if (currentMillis - lastLocalServerMs >= LOCAL_SERVER_INTERVAL_MS) {
        lastLocalServerMs = currentMillis;
        sendToLocalServer();
      }
    }
*/


// ─────────────────────────────────────────────────────────────────────────────
// STEP 4: เพิ่ม function ด้านล่างนี้ที่ท้ายไฟล์ .ino
// ─────────────────────────────────────────────────────────────────────────────

void sendToLocalServer() {
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  String url = LOCAL_SERVER_URL + "/telemetry";
  http.begin(url);
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(400);  // timeout สั้นเพื่อไม่ให้บล็อก loop หากคอมปิดอยู่

  // Payload แบบ compact  (Python จะ parse ด้วย _parse_local_json)
  StaticJsonDocument<512> doc;
  doc["t_ms"]        = millis();
  doc["state"]       = sessionStateToString(sessionState);
  doc["cal"]         = calibrationDone ? 1 : 0;
  doc["rep_count"]   = motion.repCount;
  doc["rep_target"]  = repTarget;
  doc["posture"]     = motion.postureCorrect ? "ok" : "bad";
  doc["speed_dps"]   = motion.speedDegPerSec;
  doc["alert"]       = motion.injuryAlertLevel;
  doc["alert_code"]  = motion.injuryAlertCode;
  doc["elbowL"]      = motion.elbowLeft;
  doc["elbowR"]      = motion.elbowRight;
  doc["kneeL"]       = motion.kneeLeft;
  doc["kneeR"]       = motion.kneeRight;

  String body;
  serializeJson(doc, body);

  int code = http.POST(body);

  // ไม่ต้อง Serial.print เพื่อหลีกเลี่ยง spam ใน Serial monitor
  // หากต้องการ debug ให้ uncomment:
  // if (code > 0) { Serial.printf("[Local] POST %d\n", code); }
  // else          { Serial.printf("[Local] POST fail: %s\n", http.errorToString(code).c_str()); }

  http.end();
}


// =============================================================================
// หลังแก้ไขแล้ว loop() ส่วน debug/telemetry ควรมีลักษณะดังนี้:
// =============================================================================
/*
  unsigned long currentMillis = millis();

  // ... (watchdog, motion update code ที่มีอยู่แล้ว) ...

  // Serial debug (ยังคงไว้ใช้งานได้ปกติ)
  if (ENABLE_REALTIME_SERIAL_DEBUG && currentMillis - lastSerialDebugMs >= SERIAL_DEBUG_INTERVAL_MS) {
    lastSerialDebugMs = currentMillis;
    printRealtimeDebug(currentMillis);
  }

  // *** เพิ่มส่วนนี้ ***
  if (localServerEnabled && WiFi.status() == WL_CONNECTED) {
    if (currentMillis - lastLocalServerMs >= LOCAL_SERVER_INTERVAL_MS) {
      lastLocalServerMs = currentMillis;
      sendToLocalServer();
    }
  }
*/
