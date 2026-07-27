/** Debug-mode session logger — keeps instrumentation folded and dual-writes. */
export function agentDbgLog(payload: {
  hypothesisId: string;
  location: string;
  message: string;
  data?: Record<string, unknown>;
  runId?: string;
}) {
  const entry = {
    sessionId: "095891",
    runId: payload.runId ?? "pre-fix",
    hypothesisId: payload.hypothesisId,
    location: payload.location,
    message: payload.message,
    data: payload.data ?? {},
    timestamp: Date.now(),
  };
  try {
    const w = window as unknown as { __RX_DBG?: unknown[] };
    w.__RX_DBG = w.__RX_DBG ?? [];
    w.__RX_DBG.push(entry);
    if (w.__RX_DBG.length > 300) w.__RX_DBG.splice(0, w.__RX_DBG.length - 300);
  } catch {
    /* ignore */
  }
  // #region agent log
  fetch("http://127.0.0.1:7464/ingest/2419102e-c8fd-4886-b82f-622d3aa08fb8", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": "095891",
    },
    body: JSON.stringify(entry),
  }).catch(() => undefined);
  // #endregion
}
