export interface Device {
  device_id: string;
  wifi_ssid: string;
  last_online: string;
}

export function getApiUrl() {
  return process.env.NEXT_PUBLIC_API_URL || "https://rxsmart-worker.sealseapep.workers.dev";
}

export function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown error";
}

export function isDeviceOnline(lastOnline: string, now = Date.now()) {
  const timestamp = new Date(lastOnline).getTime();
  if (Number.isNaN(timestamp)) return false;
  return now - timestamp < 5 * 60 * 1000;
}

export function formatLastSeen(isoString: string) {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return "ไม่ทราบ";
  return date.toLocaleString("th-TH", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
