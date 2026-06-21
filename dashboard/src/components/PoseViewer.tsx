"use client";

import { Canvas } from "@react-three/fiber";
import { ContactShadows, Environment, Grid, OrbitControls } from "@react-three/drei";
import { PoseKey } from "@/lib/pose";
import { SensorFrame } from "@/lib/pose-physics";
import { Mannequin } from "@/components/Mannequin";

interface PoseViewerProps {
  frame: SensorFrame;
  activeJoints?: PoseKey[];
}

export default function PoseViewer({ frame, activeJoints = [] }: PoseViewerProps) {
  return (
    <div className="h-full min-h-[340px] w-full overflow-hidden rounded-2xl border border-neutral-200/80 bg-neutral-50">
      <Canvas shadows camera={{ position: [1.7, 1.3, 2.5], fov: 40 }} gl={{ antialias: true, alpha: true }}>
        <color attach="background" args={["#fafafa"]} />
        <fog attach="fog" args={["#fafafa", 5, 11]} />
        <Environment preset="city" environmentIntensity={0.35} />
        <ambientLight intensity={0.55} />
        <directionalLight
          position={[2.5, 5.5, 3.5]}
          intensity={1.1}
          castShadow
          shadow-mapSize={[2048, 2048]}
          shadow-camera-far={12}
          shadow-camera-left={-2}
          shadow-camera-right={2}
          shadow-camera-top={2}
          shadow-camera-bottom={-0.5}
          shadow-bias={-0.0002}
        />
        <directionalLight position={[-3, 2.5, -1.5]} intensity={0.35} color="#d4d4d4" />
        <Mannequin frame={frame} activeJoints={activeJoints} />
        <Grid
          position={[0, 0, 0]}
          args={[6, 6]}
          cellSize={0.25}
          cellThickness={0.35}
          cellColor="#e5e5e5"
          sectionSize={1}
          sectionThickness={0.6}
          sectionColor="#d4d4d4"
          fadeDistance={9}
          fadeStrength={1.2}
          infiniteGrid
        />
        <ContactShadows position={[0, 0, 0]} opacity={0.35} scale={5} blur={2.5} far={2.2} color="#737373" />
        <OrbitControls
          target={[0, 1.05, 0]}
          minPolarAngle={0.25}
          maxPolarAngle={Math.PI / 2 + 0.12}
          minDistance={1.5}
          maxDistance={4.5}
          enablePan={false}
        />
      </Canvas>
    </div>
  );
}
