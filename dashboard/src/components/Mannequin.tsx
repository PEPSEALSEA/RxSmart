"use client";

import { PoseAngles } from "@/lib/pose";

const DEG = Math.PI / 180;

const BODY = "#7dd3fc";
const JOINT = "#38bdf8";
const HEAD = "#bae6fd";
const TORSO = "#0ea5e9";

function Limb({ length, radius, color = BODY }: { length: number; radius: number; color?: string }) {
  return (
    <mesh position={[0, -length / 2, 0]} castShadow>
      <capsuleGeometry args={[radius, Math.max(length - radius * 2, 0.05), 6, 12]} />
      <meshStandardMaterial color={color} roughness={0.45} metalness={0.05} />
    </mesh>
  );
}

function Joint({ radius = 0.04, color = JOINT }: { radius?: number; color?: string }) {
  return (
    <mesh castShadow>
      <sphereGeometry args={[radius, 16, 16]} />
      <meshStandardMaterial color={color} roughness={0.35} metalness={0.1} />
    </mesh>
  );
}

function Arm({
  side,
  upper,
  lower,
}: {
  side: "left" | "right";
  upper: number;
  lower: number;
}) {
  const x = side === "left" ? -0.24 : 0.24;
  const upperLen = 0.34;
  const lowerLen = 0.3;

  return (
    <group position={[x, 1.48, 0]}>
      <Joint radius={0.05} />
      <group rotation={[-upper * DEG, 0, 0]}>
        <Limb length={upperLen} radius={0.045} />
        <group position={[0, -upperLen, 0]} rotation={[-lower * DEG, 0, 0]}>
          <Joint radius={0.04} />
          <Limb length={lowerLen} radius={0.038} />
          <group position={[0, -lowerLen, 0]}>
            <Joint radius={0.032} color={HEAD} />
          </group>
        </group>
      </group>
    </group>
  );
}

function Leg({
  side,
  upper,
  lower,
}: {
  side: "left" | "right";
  upper: number;
  lower: number;
}) {
  const x = side === "left" ? -0.13 : 0.13;
  const upperLen = 0.42;
  const lowerLen = 0.4;

  return (
    <group position={[x, 0.98, 0]}>
      <Joint radius={0.05} />
      <group rotation={[-upper * DEG, 0, 0]}>
        <Limb length={upperLen} radius={0.055} />
        <group position={[0, -upperLen, 0]} rotation={[-lower * DEG, 0, 0]}>
          <Joint radius={0.045} />
          <Limb length={lowerLen} radius={0.048} />
          <group position={[0, -lowerLen, 0]}>
            <Joint radius={0.04} color={HEAD} />
          </group>
        </group>
      </group>
    </group>
  );
}

export function Mannequin({ pose }: { pose: PoseAngles }) {
  return (
    <group position={[0, 0.02, 0]}>
      <mesh position={[0, 1.22, 0]} castShadow>
        <boxGeometry args={[0.36, 0.52, 0.18]} />
        <meshStandardMaterial color={TORSO} roughness={0.4} metalness={0.08} />
      </mesh>

      <mesh position={[0, 1.58, 0]} castShadow>
        <sphereGeometry args={[0.13, 24, 24]} />
        <meshStandardMaterial color={HEAD} roughness={0.35} metalness={0.05} />
      </mesh>

      <mesh position={[0, 1.02, 0]} castShadow>
        <boxGeometry args={[0.28, 0.12, 0.14]} />
        <meshStandardMaterial color={TORSO} roughness={0.4} metalness={0.08} />
      </mesh>

      <Arm side="left" upper={pose.l_arm_upper} lower={pose.l_arm_lower} />
      <Arm side="right" upper={pose.r_arm_upper} lower={pose.r_arm_lower} />
      <Leg side="left" upper={pose.l_leg_upper} lower={pose.l_leg_lower} />
      <Leg side="right" upper={pose.r_leg_upper} lower={pose.r_leg_lower} />
    </group>
  );
}
