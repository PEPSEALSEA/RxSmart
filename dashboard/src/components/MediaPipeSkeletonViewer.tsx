"use client";

import { Canvas } from "@react-three/fiber";
import { Line, OrbitControls } from "@react-three/drei";
import { useMemo } from "react";
import {
  HAND_CONNECTIONS,
  MediaPipeHandSet,
  MediaPipeLandmark,
  POSE_CONNECTIONS,
  handLandmarksToPoints,
  landmarksToPoints,
} from "@/lib/mediapipe-pose";

interface MediaPipeSkeletonViewerProps {
  landmarks: MediaPipeLandmark[] | null;
  hands?: MediaPipeHandSet[] | null;
  skeletonDebug?: boolean;
}

function SkeletonLines({
  points,
  connections,
  color,
}: {
  points: [number, number, number][];
  connections: ReadonlyArray<readonly [number, number]>;
  color: string;
}) {
  return (
    <>
      {connections.map(([a, b]) => {
        if (!points[a] || !points[b]) return null;
        return (
          <Line
            key={`${a}-${b}`}
            points={[points[a], points[b]]}
            color={color}
            lineWidth={2}
            transparent
            opacity={0.95}
          />
        );
      })}
      {points.map((p, i) => (
        <mesh key={`joint-${i}`} position={p}>
          <sphereGeometry args={[0.028, 10, 10]} />
          <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.35} />
        </mesh>
      ))}
    </>
  );
}

function SceneContent({
  landmarks,
  hands,
  skeletonDebug,
}: MediaPipeSkeletonViewerProps) {
  const posePoints = useMemo(
    () => (landmarks && landmarks.length >= 33 ? landmarksToPoints(landmarks) : []),
    [landmarks],
  );

  const handScenes = useMemo(() => {
    if (!hands?.length || posePoints.length < 16) return [];

    return hands
      .map((hand) => {
        const wristIdx = hand.label === "Left" ? 15 : 16;
        const anchor = posePoints[wristIdx];
        if (!anchor) return null;
        return {
          label: hand.label,
          points: handLandmarksToPoints(hand.landmarks, anchor),
        };
      })
      .filter(Boolean) as { label: string; points: [number, number, number][] }[];
  }, [hands, posePoints]);

  if (posePoints.length === 0) {
    return (
      <mesh position={[0, 0, 0]}>
        <boxGeometry args={[0.01, 0.01, 0.01]} />
        <meshBasicMaterial visible={false} />
      </mesh>
    );
  }

  return (
    <>
      <SkeletonLines
        points={posePoints}
        connections={POSE_CONNECTIONS}
        color={skeletonDebug ? "#fbbf24" : "#78716c"}
      />
      {handScenes.map((hand) => (
        <SkeletonLines
          key={hand.label}
          points={hand.points}
          connections={HAND_CONNECTIONS}
          color={hand.label === "Left" ? "#38bdf8" : "#fb7185"}
        />
      ))}
    </>
  );
}

export default function MediaPipeSkeletonViewer({
  landmarks,
  hands,
  skeletonDebug = false,
}: MediaPipeSkeletonViewerProps) {
  const hasPose = Boolean(landmarks && landmarks.length >= 33);

  return (
    <div className="relative h-full min-h-[340px] w-full overflow-hidden rounded-2xl border border-neutral-200/80 bg-neutral-50">
      <Canvas
        shadows={false}
        camera={{ position: [0, 0.1, 2.8], fov: 42 }}
        gl={{ antialias: true, alpha: true }}
      >
        <color attach="background" args={[skeletonDebug ? "#0a0a0a" : "#fafafa"]} />
        <ambientLight intensity={skeletonDebug ? 0.85 : 0.65} />
        <directionalLight position={[2, 3, 4]} intensity={0.8} />
        <SceneContent landmarks={landmarks} hands={hands} skeletonDebug={skeletonDebug} />
        <OrbitControls
          target={[0, 0, 0]}
          minPolarAngle={0.1}
          maxPolarAngle={Math.PI - 0.1}
          minDistance={1.2}
          maxDistance={5}
          enablePan
        />
      </Canvas>
      {!hasPose && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <p className="rounded-xl bg-white/90 px-4 py-2 text-xs text-neutral-500 shadow-sm">
            รอ MediaPipe pose — ยืนให้อยู่ในกล้อง
          </p>
        </div>
      )}
      {hasPose && (
        <div className="pointer-events-none absolute bottom-3 left-3 rounded-lg bg-black/50 px-2.5 py-1 text-[10px] text-neutral-200">
          MediaPipe landmarks (1:1) · ลากหมุน/zoom
        </div>
      )}
    </div>
  );
}
