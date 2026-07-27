"use client";

import { Canvas } from "@react-three/fiber";
import { ContactShadows, Environment, Grid, OrbitControls } from "@react-three/drei";
import { Suspense, useEffect, useMemo } from "react";
import { Mannequin } from "@/components/Mannequin";
import { PoseKey } from "@/lib/pose";
import { SensorFrame } from "@/lib/pose-physics";
import { agentDbgLog } from "@/lib/debug-session-log";

interface GamePoseCanvasProps {
  frame: SensorFrame;
  ghostFrame?: SensorFrame | null;
  activeJoints?: PoseKey[];
  showGhost?: boolean;
  imuMode?: boolean;
  tension?: "idle" | "move" | "hold";
}

const MIRROR_JOINT: Record<PoseKey, PoseKey> = {
  l_arm_upper: "r_arm_upper",
  r_arm_upper: "l_arm_upper",
  l_arm_lower: "r_arm_lower",
  r_arm_lower: "l_arm_lower",
  l_leg_upper: "r_leg_upper",
  r_leg_upper: "l_leg_upper",
  l_leg_lower: "r_leg_lower",
  r_leg_lower: "l_leg_lower",
};

function mirrorPoseFrame(frame: SensorFrame): SensorFrame {
  return {
    ...frame,
    l_arm_upper: { ...frame.r_arm_upper },
    r_arm_upper: { ...frame.l_arm_upper },
    l_arm_lower: { ...frame.r_arm_lower },
    r_arm_lower: { ...frame.l_arm_lower },
    l_leg_upper: { ...frame.r_leg_upper },
    r_leg_upper: { ...frame.l_leg_upper },
    l_leg_lower: { ...frame.r_leg_lower },
    r_leg_lower: { ...frame.l_leg_lower },
  };
}

function mirrorJoints(joints: PoseKey[]): PoseKey[] {
  return joints.map((key) => MIRROR_JOINT[key] ?? key);
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
      <Suspense fallback={null}>
        <Environment preset="warehouse" environmentIntensity={0.42} />
      </Suspense>
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
  mirror,
}: {
  frame: SensorFrame;
  ghostFrame?: SensorFrame | null;
  activeJoints?: PoseKey[];
  showGhost?: boolean;
  mirror?: boolean;
}) {
  const player = useMemo(() => (mirror ? mirrorPoseFrame(frame) : frame), [frame, mirror]);
  const ghost = useMemo(
    () => (ghostFrame && mirror ? mirrorPoseFrame(ghostFrame) : ghostFrame),
    [ghostFrame, mirror],
  );
  const joints = useMemo(
    () => (mirror ? mirrorJoints(activeJoints ?? []) : (activeJoints ?? [])),
    [activeJoints, mirror],
  );

  return (
    <group>
      <group position={showGhost ? [-0.55, 0, 0] : [0, 0, 0]}>
        <Mannequin frame={player} activeJoints={joints} />
      </group>
      {showGhost && ghost && (
        <group position={[0.7, 0, 0]}>
          <Mannequin frame={ghost} activeJoints={joints} />
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
  imuMode = false,
  tension = "idle",
}: GamePoseCanvasProps) {
  // #region agent log
  const hasGhost = Boolean(ghostFrame);
  const activeCount = activeJoints?.length ?? 0;
  useEffect(() => {
    agentDbgLog({
      hypothesisId: "E",
      location: "GamePoseCanvas.tsx:glbMode",
      message: "avatar using stable Mannequin",
      data: {
        glbMode: "mannequin",
        tension,
        hasGhost,
        activeCount,
        mirror: imuMode,
      },
    });
  }, [tension, activeCount, hasGhost, imuMode]);
  // #endregion

  return (
    <>
      <StageLights tension={tension} />
      <MannequinPair
        frame={frame}
        ghostFrame={ghostFrame}
        activeJoints={activeJoints}
        showGhost={showGhost}
        mirror={imuMode}
      />
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
