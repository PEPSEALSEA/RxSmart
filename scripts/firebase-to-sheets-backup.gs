/**
 * RxSmart — Google Sheets Automatic Backup from Firebase Realtime Database
 * 
 * วิธีใช้งาน:
 * 1. เปิด Google Sheet ที่ต้องการเก็บข้อมูล
 * 2. ไปที่เมนู ส่วนขยาย (Extensions) > Apps Script
 * 3. ลบโค้ดเดิมทั้งหมด แล้ววางโค้ดนี้ลงไป
 * 4. บันทึก (Save) แล้วกดเลือกฟังก์ชัน "setupSheetHeaders" แล้วกด "เรียกใช้" (Run) 1 ครั้ง
 * 5. กดเลือกฟังก์ชัน "installAutoBackupTrigger" แล้วกด "เรียกใช้" (Run) เพื่อตั้งเวลาสำรองข้อมูลอัตโนมัติทุก 5 นาที
 */

const FIREBASE_RTDB_URL = "https://secret-timeloop-2026-default-rtdb.asia-southeast1.firebasedatabase.app";

// 1. สร้างหัวตาราง (Run ครั้งแรกครั้งเดียว)
function setupSheetHeaders() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  
  // Sheet: Sessions (ประวัติการฝึก)
  let sessSheet = ss.getSheetByName("Sessions");
  if (!sessSheet) {
    sessSheet = ss.insertSheet("Sessions");
  }
  sessSheet.getRange(1, 1, 1, 9).setValues([[
    "Timestamp", "Session_ID", "Device_ID", "Exercise_ID", "State", "Reps_Done", "Reps_Target", "Duration_Sec", "Posture_Fault_Mask"
  ]]).setFontWeight("bold").setBackground("#e8f0fe");

  // Sheet: Devices (รายการอุปกรณ์)
  let devSheet = ss.getSheetByName("Devices");
  if (!devSheet) {
    devSheet = ss.insertSheet("Devices");
  }
  devSheet.getRange(1, 1, 1, 6).setValues([[
    "Device_ID", "Platform", "Firmware", "WiFi_SSID", "Last_Online", "Last_Updated"
  ]]).setFontWeight("bold").setBackground("#e6f4ea");

  // Sheet: Snapshots (ค่ามุม/ท่าทางล่าสุด)
  let snapSheet = ss.getSheetByName("Snapshots");
  if (!snapSheet) {
    snapSheet = ss.insertSheet("Snapshots");
  }
  snapSheet.getRange(1, 1, 1, 11).setValues([[
    "Timestamp", "Device_ID", "Status", "Elbow_Left", "Elbow_Right", "Knee_Left", "Knee_Right", "Primary_Angle", "Speed_DPS", "Posture", "Alert"
  ]]).setFontWeight("bold").setBackground("#fef7e0");

  SpreadsheetApp.flush();
  Logger.log("สร้างหัวตารางสำเร็จทั้ง 3 แผ่น (Sessions, Devices, Snapshots)");
}

// 2. ฟังก์ชันสำรองข้อมูลจาก Firebase RTDB ลง Google Sheets
function backupFirebaseToSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  
  // --- A. สำรองข้อมูล Sessions ---
  try {
    const sessRes = UrlFetchApp.fetch(`${FIREBASE_RTDB_URL}/rxsmart/sessions.json`, { muteHttpExceptions: true });
    if (sessRes.getResponseCode() === 200) {
      const sessions = JSON.parse(sessRes.getContentText()) || {};
      const sessSheet = ss.getSheetByName("Sessions") || ss.insertSheet("Sessions");
      
      // อ่าน session_id ที่มีอยู่แล้วเพื่อไม่ให้เขียนซ้ำ
      const lastRow = sessSheet.getLastRow();
      let existingIds = new Set();
      if (lastRow > 1) {
        const idCol = sessSheet.getRange(2, 2, lastRow - 1, 1).getValues();
        idCol.forEach(r => existingIds.add(String(r[0])));
      }

      const rowsToAppend = [];
      for (const [id, s] of Object.entries(sessions)) {
        if (!existingIds.has(id) && s) {
          const startTime = s.started_at ? Number(s.started_at) : Date.now();
          const endTime = s.completed_at ? Number(s.completed_at) : startTime;
          const durationSec = Math.round(Math.max(0, endTime - startTime) / 1000);

          rowsToAppend.push([
            new Date(endTime).toISOString(),
            id,
            s.device_id || "",
            s.exercise_id || "",
            s.state || "complete",
            s.rep_final || s.rep_count || 0,
            s.rep_target || 0,
            durationSec,
            s.posture_fault_mask || 0
          ]);

          // ทำเครื่องหมายใน Firebase ว่าสำรองแล้ว
          try {
            UrlFetchApp.fetch(`${FIREBASE_RTDB_URL}/rxsmart/sessions/${id}/backed_up_to_sheets.json`, {
              method: "PUT",
              contentType: "application/json",
              payload: "true",
              muteHttpExceptions: true
            });
          } catch (_) {}
        }
      }

      if (rowsToAppend.length > 0) {
        sessSheet.getRange(sessSheet.getLastRow() + 1, 1, rowsToAppend.length, rowsToAppend[0].length).setValues(rowsToAppend);
        Logger.log(`สำรอง Sessions ใหม่ ${rowsToAppend.length} รายการ`);
      }
    }
  } catch (err) {
    Logger.log(`Sessions backup error: ${err.message}`);
  }

  // --- B. สำรองสถานะ Devices & Snapshots ---
  try {
    const devRes = UrlFetchApp.fetch(`${FIREBASE_RTDB_URL}/rxsmart/devices.json`, { muteHttpExceptions: true });
    if (devRes.getResponseCode() === 200) {
      const devices = JSON.parse(devRes.getContentText()) || {};
      const devSheet = ss.getSheetByName("Devices") || ss.insertSheet("Devices");
      const snapSheet = ss.getSheetByName("Snapshots") || ss.insertSheet("Snapshots");

      const devRows = [];
      const snapRows = [];

      for (const [devId, d] of Object.entries(devices)) {
        if (!d) continue;
        const info = d.info || {};
        const live = d.live || {};

        devRows.push([
          devId,
          info.platform || "pico2w",
          info.firmware_version || "1.0.2",
          info.wifi_ssid || "",
          info.last_online ? new Date(Number(info.last_online)).toISOString() : "",
          new Date().toISOString()
        ]);

        if (live && live.ts) {
          const angles = live.angles || {};
          const posture = live.posture || {};
          snapRows.push([
            new Date(Number(live.ts)).toISOString(),
            devId,
            live.status || live.session_state || "Active",
            angles.elbow_left ?? "",
            angles.elbow_right ?? "",
            angles.knee_left ?? "",
            angles.knee_right ?? "",
            angles.primary ?? "",
            live.speed_dps ?? "",
            posture.state || "",
            live.alert_level || "none"
          ]);
        }
      }

      // อัปเดต Devices (เขียนทับแถวอุปกรณ์ทั้งหมดให้ทันสมัย)
      if (devRows.length > 0) {
        if (devSheet.getLastRow() > 1) {
          devSheet.getRange(2, 1, devSheet.getLastRow() - 1, 6).clearContent();
        }
        devSheet.getRange(2, 1, devRows.length, devRows[0].length).setValues(devRows);
      }

      // Append Snapshots ล่าสุด (จำกัดไม่เกิน 500 แถวเพื่อไม่ให้ชีตแน่น)
      if (snapRows.length > 0) {
        snapSheet.getRange(snapSheet.getLastRow() + 1, 1, snapRows.length, snapRows[0].length).setValues(snapRows);
        if (snapSheet.getLastRow() > 500) {
          snapSheet.deleteRows(2, snapSheet.getLastRow() - 500);
        }
      }
    }
  } catch (err) {
    Logger.log(`Devices backup error: ${err.message}`);
  }
}

// 3. ติดตั้ง Trigger ทำงานอัตโนมัติทุก 5 นาที
function installAutoBackupTrigger() {
  // ลบ trigger เก่าที่มีชื่อเดียวกันออกก่อน
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === "backupFirebaseToSheets") {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }

  // สร้าง Trigger ใหม่ ทุก 5 นาที
  ScriptApp.newTrigger("backupFirebaseToSheets")
    .timeBased()
    .everyMinutes(5)
    .create();

  Logger.log("ติดตั้ง Trigger สำรองข้อมูลทุก 5 นาทีเรียบร้อยแล้ว!");
}
