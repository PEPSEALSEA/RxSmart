import type { MediaPipeLandmark } from "@/lib/mediapipe-pose";
import { POSE_CONNECTIONS } from "@/lib/mediapipe-pose";

export { POSE_CONNECTIONS };

/** BlazePose foot / ankle indices used for ground planting. */
const FOOT_INDICES = [27, 28, 29, 30, 31, 32] as const;
const HIP_L = 23;
const HIP_R = 24;

export type Vec3 = [number, number, number];

/**
 * Convert MediaPipe pose landmarks into Three.js space with soles on y=0.
 *
 * Prefer `pose_world_landmarks` (meters, hip origin). Image-normalized
 * landmarks are a fallback and get a crude aspect-aware scale.
 */
export function landmarksToGroundedPoints(
  landmarks: MediaPipeLandmark[],
  opts: { worldSpace?: boolean; scale?: number } = {},
): Vec3[] {
  if (landmarks.length < 33) return [];

  const worldSpace = opts.worldSpace ?? true;
  const scale = opts.scale ?? (worldSpace ? 1 : 2.2);

  const lh = landmarks[HIP_L];
  const rh = landmarks[HIP_R];
  const midX = (lh.x + rh.x) * 0.5;
  const midZ = (lh.z + rh.z) * 0.5;

  const raw: Vec3[] = landmarks.map((lm) => {
    if (worldSpace) {
      // MediaPipe world: +X right, +Y up, +Z toward camera → Three: flip Z
      return [(lm.x - midX) * scale, lm.y * scale, -(lm.z - midZ) * scale];
    }
    // Image-normalized: y grows down; treat as pseudo-3D only as last resort
    return [
      (lm.x - midX) * scale,
      -(lm.y - (lh.y + rh.y) * 0.5) * scale,
      -(lm.z - midZ) * scale,
    ];
  });

  let minFootY = Infinity;
  for (const idx of FOOT_INDICES) {
    const p = raw[idx];
    if (p && Number.isFinite(p[1])) minFootY = Math.min(minFootY, p[1]);
  }
  if (!Number.isFinite(minFootY)) {
    minFootY = Math.min(...raw.map((p) => p[1]));
  }

  return raw.map(([x, y, z]) => [x, y - minFootY, z]);
}

/** Exponential moving average per joint — kills standing-still jitter / "fly". */
export class LandmarkSmoother {
  private prev: Vec3[] | null = null;
  private readonly alpha: number;

  constructor(alpha = 0.35) {
    this.alpha = Math.min(1, Math.max(0.05, alpha));
  }

  reset() {
    this.prev = null;
  }

  step(points: Vec3[]): Vec3[] {
    if (points.length === 0) {
      this.prev = null;
      return [];
    }
    if (!this.prev || this.prev.length !== points.length) {
      this.prev = points.map((p) => [...p] as Vec3);
      return points.map((p) => [...p] as Vec3);
    }

    const a = this.alpha;
    const out: Vec3[] = points.map((p, i) => {
      const q = this.prev![i];
      return [
        q[0] + (p[0] - q[0]) * a,
        q[1] + (p[1] - q[1]) * a,
        q[2] + (p[2] - q[2]) * a,
      ];
    });
    this.prev = out.map((p) => [...p] as Vec3);
    return out;
  }
}
