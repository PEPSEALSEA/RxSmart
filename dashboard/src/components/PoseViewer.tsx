"use client";

import { Canvas } from "@react-three/fiber";
import { ContactShadows, Grid, OrbitControls } from "@react-three/drei";
import { PoseKey } from "@/lib/pose";
import { SensorFrame } from "@/lib/pose-physics";
import { Mannequin } from "@/components/Mannequin";

interface PoseViewerProps {
  frame: SensorFrame;
  activeJoints?: PoseKey[];
}

export default function PoseViewer({ frame, activeJoints = [] }: PoseViewerProps) {
  return (
    <div className="h-full min-h-[340px] w-full overflow-hidden rounded-2xl border border-sky-100 bg-gradient-to-b from-sky-100/80 to-white">
      <Canvas shadows camera={{ position: [1.8, 1.35, 2.6], fov: 42 }} gl={{ antialias: true, alpha: true }}>
        <color attach="background" args={["#e0f2fe"]} />
        <fog attach="fog" args={["#e0f2fe", 4, 9]} />
        <ambientLight intensity={0.55} />
        <directionalLight position={[3, 6, 4]} intensity={1.1} castShadow shadow-mapSize={[1024, 1024]} />
        <directionalLight position={[-4, 2, -2]} intensity={0.35} color="#bae6fd" />
        <Mannequin frame={frame} activeJoints={activeJoints} />
        <Grid
          position={[0, 0, 0]}
          args={[6, 6]}
          cellSize={0.25}
          cellThickness={0.5}
          cellColor="#bae6fd"
          sectionSize={1}
          sectionThickness={1}
          sectionColor="#7dd3fc"
          fadeDistance={8}
          fadeStrength={1}
          infiniteGrid
        />
        <ContactShadows position={[0, 0, 0]} opacity={0.35} scale={6} blur={2} far={2} />
        <OrbitControls
          target={[0, 1.05, 0]}
          minPolarAngle={0.2}
          maxPolarAngle={Math.PI / 2 + 0.15}
          minDistance={1.6}
          maxDistance={5}
          enablePan={false}
        />
      </Canvas>
    </div>
  );
}
