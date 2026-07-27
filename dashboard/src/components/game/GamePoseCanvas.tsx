"use client";

import { Canvas } from "@react-three/fiber";
import { ContactShadows, Environment, Grid, OrbitControls } from "@react-three/drei";
import {
  Component,
  Suspense,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { GlbAvatar } from "@/components/game/GlbAvatar";
import { Mannequin } from "@/components/Mannequin";
import { PoseKey } from "@/lib/pose";
import { SensorFrame } from "@/lib/pose-physics";
import { agentDbgLog } from "@/lib/debug-session-log";

const GLB_LOAD_TIMEOUT_MS = 2500;

interface GamePoseCanvasProps {
  frame: SensorFrame;
  ghostFrame?: SensorFrame | null;
  activeJoints?: PoseKey[];
  showGhost?: boolean;
  imuMode?: boolean;
  tension?: "idle" | "move" | "hold";
}

type GlbMode = "pending" | "ready" | "failed";

class AvatarErrorBoundary extends Component<
  { fallback: ReactNode; children: ReactNode; onError?: () => void },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    this.props.onError?.();
  }

  render() {
    if (this.state.failed) return this.props.fallback;
    return this.props.children;
  }
}

function StageLights({ tension = "idle" }: { tension?: "idle" | "move" | "hold" }) {
  const spot =
    tension === "hold" ? "#f0c14a" : tension === "move" ? "#7ec8b8" : "#d8c9a8";
  const fill =
    tension === "hold" ? "#e8a84a" : tension === "move" ? "#5aa897" : "#8aa0b0";
  return (
    <>
      <color attach="background" args={["#2a3544"]} />
      <fog attach="fog" args={["#2a3544", 11, 24]} />
      <Environment preset="warehouse" environmentIntensity={0.42} />
      <ambientLight intensity={0.72} />
      <directionalLight
        position={[3, 6, 2]}
        intensity={1.45}
        castShadow
        shadow-mapSize={[2048, 2048]}
        color="#fff6e8"
      />
      <directionalLight position={[-2.5, 3, -2]} intensity={0.55} color={fill} />
      <spotLight
        position={[0, 5.5, 3.2]}
        angle={0.6}
        penumbra={0.55}
        intensity={tension === "hold" ? 1.7 : 1.15}
        color={spot}
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
        cellThickness={0.45}
        cellColor="#3d4a5c"
        sectionSize={1.4}
        sectionThickness={0.95}
        sectionColor="#5c6b7c"
        fadeDistance={12}
        fadeStrength={1.1}
        infiniteGrid
      />
      <ContactShadows
        position={[0, 0.01, 0]}
        opacity={0.6}
        scale={6}
        blur={2.6}
        far={2.5}
        color="#020617"
      />
      <OrbitControls
        target={[0, 1.05, 0]}
        minPolarAngle={0.2}
        maxPolarAngle={Math.PI / 2 + 0.08}
        minDistance={1.5}
        maxDistance={5}
        enablePan={false}
      />
    </>
  );
}

function MannequinPair({
  frame,
  ghostFrame,
  activeJoints,
  showGhost,
}: {
  frame: SensorFrame;
  ghostFrame?: SensorFrame | null;
  activeJoints?: PoseKey[];
  showGhost?: boolean;
}) {
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

function GlbPair({
  frame,
  ghostFrame,
  activeJoints,
  showGhost,
  imuMode,
  onReady,
  onError,
}: {
  frame: SensorFrame;
  ghostFrame?: SensorFrame | null;
  activeJoints?: PoseKey[];
  showGhost?: boolean;
  imuMode?: boolean;
  onReady: () => void;
  onError: () => void;
}) {
  return (
    <group>
      <GlbAvatar
        frame={frame}
        activeJoints={activeJoints}
        position={showGhost ? [-0.55, 0, 0] : [0, 0, 0]}
        scale={1}
        imuMode={imuMode}
        onReady={onReady}
        onError={onError}
      />
      {showGhost && ghostFrame && (
        <GlbAvatar
          frame={ghostFrame}
          activeJoints={activeJoints}
          opacity={0.48}
          tint="#7ec8b8"
          ghost
          position={[0.7, 0, 0]}
          scale={1}
          imuMode={imuMode}
        />
      )}
    </group>
  );
}

function StageScene({
  frame,
  ghostFrame,
  activeJoints,
  showGhost,
  imuMode = false,
  tension = "idle",
}: GamePoseCanvasProps) {
  const [glbMode, setGlbMode] = useState<GlbMode>("pending");

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setGlbMode((mode) => (mode === "pending" ? "failed" : mode));
    }, GLB_LOAD_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, []);

  const markReady = () => setGlbMode((mode) => (mode === "failed" ? mode : "ready"));
  const markFailed = () => setGlbMode("failed");

  // #region agent log
  useEffect(() => {
    agentDbgLog({
      hypothesisId: "E",
      location: "GamePoseCanvas.tsx:glbMode",
      message: "avatar glbMode changed",
      data: {
        glbMode,
        tension,
        imuMode,
        hasGhost: Boolean(ghostFrame),
        activeCount: activeJoints?.length ?? 0,
      },
    });
  }, [glbMode, tension, imuMode, activeJoints]);
  // #endregion

  return (
    <>
      <StageLights tension={tension} />
      {glbMode !== "ready" && (
        <MannequinPair
          frame={frame}
          ghostFrame={ghostFrame}
          activeJoints={activeJoints}
          showGhost={showGhost}
        />
      )}
      {glbMode !== "failed" && (
        <AvatarErrorBoundary fallback={null} onError={markFailed}>
          <Suspense fallback={null}>
            <GlbPair
              frame={frame}
              ghostFrame={ghostFrame}
              activeJoints={activeJoints}
              showGhost={showGhost}
              imuMode={imuMode}
              onReady={markReady}
              onError={markFailed}
            />
          </Suspense>
        </AvatarErrorBoundary>
      )}
      <StageFloor />
    </>
  );
}

export default function GamePoseCanvas({
  frame,
  ghostFrame = null,
  activeJoints = [],
  showGhost = true,
  imuMode = false,
  tension = "idle",
}: GamePoseCanvasProps) {
  return (
    <div className="h-full min-h-[420px] w-full overflow-hidden bg-[#2a3544]">
      <Canvas
        shadows
        camera={{ position: [1.8, 1.35, 2.6], fov: 40 }}
        gl={{ antialias: true }}
      >
        <StageScene
          frame={frame}
          ghostFrame={ghostFrame}
          activeJoints={activeJoints}
          showGhost={showGhost}
          imuMode={imuMode}
          tension={tension}
        />
      </Canvas>
    </div>
  );
}
