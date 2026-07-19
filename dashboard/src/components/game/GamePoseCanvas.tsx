"use client";

import { Canvas } from "@react-three/fiber";
import { ContactShadows, Environment, Grid, OrbitControls } from "@react-three/drei";
import { Component, type ReactNode, Suspense } from "react";
import { GlbAvatar } from "@/components/game/GlbAvatar";
import { Mannequin } from "@/components/Mannequin";
import { PoseKey } from "@/lib/pose";
import { SensorFrame } from "@/lib/pose-physics";

interface GamePoseCanvasProps {
  frame: SensorFrame;
  ghostFrame?: SensorFrame | null;
  activeJoints?: PoseKey[];
  showGhost?: boolean;
}

class AvatarErrorBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) return this.props.fallback;
    return this.props.children;
  }
}

function StageLights() {
  return (
    <>
      <color attach="background" args={["#0b1220"]} />
      <fog attach="fog" args={["#0b1220", 6, 14]} />
      <Environment preset="night" environmentIntensity={0.45} />
      <ambientLight intensity={0.35} />
      <directionalLight
        position={[3, 6, 2]}
        intensity={1.35}
        castShadow
        shadow-mapSize={[2048, 2048]}
        color="#e2e8f0"
      />
      <directionalLight position={[-2.5, 3, -2]} intensity={0.45} color="#38bdf8" />
      <spotLight
        position={[0, 5, 3]}
        angle={0.55}
        penumbra={0.6}
        intensity={1.1}
        color="#7dd3fc"
      />
    </>
  );
}

function StageFloor() {
  return (
    <>
      <Grid
        position={[0, 0, 0]}
        args={[8, 8]}
        cellSize={0.35}
        cellThickness={0.4}
        cellColor="#1e293b"
        sectionSize={1.4}
        sectionThickness={0.85}
        sectionColor="#334155"
        fadeDistance={10}
        fadeStrength={1.4}
        infiniteGrid
      />
      <ContactShadows position={[0, 0.01, 0]} opacity={0.55} scale={6} blur={2.8} far={2.5} color="#020617" />
      <OrbitControls
        target={[0, 1.05, 0]}
        minPolarAngle={0.2}
        maxPolarAngle={Math.PI / 2 + 0.05}
        minDistance={1.6}
        maxDistance={5}
        enablePan={false}
      />
    </>
  );
}

function MannequinFallback({
  frame,
  ghostFrame,
  activeJoints,
  showGhost,
}: GamePoseCanvasProps) {
  return (
    <group>
      <group position={showGhost ? [-0.55, 0, 0] : [0, 0, 0]}>
        <Mannequin frame={frame} activeJoints={activeJoints} />
      </group>
      {showGhost && ghostFrame && (
        <group position={[0.7, 0, 0]}>
          <Mannequin frame={ghostFrame} activeJoints={activeJoints} />
        </group>
      )}
    </group>
  );
}

function StageScene({
  frame,
  ghostFrame,
  activeJoints,
  showGhost,
}: GamePoseCanvasProps) {
  const fallback = (
    <MannequinFallback
      frame={frame}
      ghostFrame={ghostFrame}
      activeJoints={activeJoints}
      showGhost={showGhost}
    />
  );

  return (
    <>
      <StageLights />
      <AvatarErrorBoundary fallback={fallback}>
        <Suspense fallback={fallback}>
          <GlbAvatar
            frame={frame}
            activeJoints={activeJoints}
            position={showGhost ? [-0.55, 0, 0] : [0, 0, 0]}
            scale={1}
          />
          {showGhost && ghostFrame && (
            <GlbAvatar
              frame={ghostFrame}
              activeJoints={activeJoints}
              opacity={0.42}
              tint="#67e8f9"
              ghost
              position={[0.7, 0, 0]}
              scale={1}
            />
          )}
        </Suspense>
      </AvatarErrorBoundary>
      <StageFloor />
    </>
  );
}

export default function GamePoseCanvas({
  frame,
  ghostFrame = null,
  activeJoints = [],
  showGhost = true,
}: GamePoseCanvasProps) {
  return (
    <div className="h-full min-h-[420px] w-full overflow-hidden bg-[#0b1220]">
      <Canvas shadows camera={{ position: [2.1, 1.45, 2.8], fov: 38 }} gl={{ antialias: true }}>
        <StageScene
          frame={frame}
          ghostFrame={ghostFrame}
          activeJoints={activeJoints}
          showGhost={showGhost}
        />
      </Canvas>
    </div>
  );
}
