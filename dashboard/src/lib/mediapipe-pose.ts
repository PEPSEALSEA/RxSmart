export type MediaPipeLandmark = {
  x: number;
  y: number;
  z: number;
  visibility?: number;
};

export type MediaPipeHandSet = {
  label: string;
  landmarks: MediaPipeLandmark[];
};

export const POSE_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 7],
  [0, 4],
  [4, 5],
  [5, 6],
  [6, 8],
  [9, 10],
  [11, 12],
  [11, 13],
  [13, 15],
  [15, 17],
  [15, 19],
  [15, 21],
  [17, 19],
  [12, 14],
  [14, 16],
  [16, 18],
  [16, 20],
  [16, 22],
  [18, 20],
  [11, 23],
  [12, 24],
  [23, 24],
  [23, 25],
  [24, 26],
  [25, 27],
  [26, 28],
  [27, 29],
  [28, 30],
  [29, 31],
  [30, 32],
  [27, 31],
  [28, 32],
];

export const HAND_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4],
  [0, 5],
  [5, 6],
  [6, 7],
  [7, 8],
  [0, 9],
  [9, 10],
  [10, 11],
  [11, 12],
  [0, 13],
  [13, 14],
  [14, 15],
  [15, 16],
  [0, 17],
  [17, 18],
  [18, 19],
  [19, 20],
  [5, 9],
  [9, 13],
  [13, 17],
];

export function landmarksToPoints(
  landmarks: MediaPipeLandmark[],
  scale = 2.4,
): [number, number, number][] {
  if (landmarks.length < 25) return [];

  const lh = landmarks[23];
  const rh = landmarks[24];
  const cx = (lh.x + rh.x) / 2;
  const cy = (lh.y + rh.y) / 2;
  const cz = (lh.z + rh.z) / 2;

  return landmarks.map((lm) => [
    (lm.x - cx) * scale,
    -(lm.y - cy) * scale,
    -(lm.z - cz) * scale,
  ] as [number, number, number]);
}

export function handLandmarksToPoints(
  landmarks: MediaPipeLandmark[],
  wristAnchor: [number, number, number],
  scale = 2.4,
): [number, number, number][] {
  if (landmarks.length < 21) return [];

  const wrist = landmarks[0];
  return landmarks.map((lm) => [
    wristAnchor[0] + (lm.x - wrist.x) * scale,
    wristAnchor[1] - (lm.y - wrist.y) * scale,
    wristAnchor[2] - (lm.z - wrist.z) * scale,
  ] as [number, number, number]);
}
