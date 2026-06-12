"use client";

import { useFrame } from "@react-three/fiber";
import { type RefObject, useRef } from "react";
import { Group } from "three";
import { SEGMENT_LENGTHS } from "@/lib/biomechanics";
import { PoseKey, UPPER_KEYS, shortestPlaneDelta } from "@/lib/pose";
import { SensorFrame } from "@/lib/pose-physics";

const DEG = Math.PI / 180;

const BODY = "#7dd3fc";
const JOINT = "#38bdf8";
const HEAD = "#bae6fd";
const TORSO = "#0ea5e9";
const ACTIVE = "#22d3ee";

const VISUAL_SPRING = 16;
const VISUAL_DAMP = 8;

function Limb({ length, radius, color = BODY }: { length: number; radius: number; color?: string }) {
  return (
    <mesh position={[0, -length / 2, 0]} castShadow>
      <capsuleGeometry args={[radius, Math.max(length - radius * 2, 0.05), 8, 16]} />
      <meshStandardMaterial color={color} roughness={0.42} metalness={0.06} />
    </mesh>
  );
}

function JointSphere({ radius = 0.04, color = JOINT }: { radius?: number; color?: string }) {
  return (
    <mesh castShadow>
      <sphereGeometry args={[radius, 20, 20]} />
      <meshStandardMaterial color={color} roughness={0.32} metalness={0.12} />
    </mesh>
  );
}

interface MannequinProps {
  frame: SensorFrame;
  activeJoints?: PoseKey[];
}

type VisualUpper = { elevation: number; plane: number };
type VisualLower = { bend: number };

export function Mannequin({ frame, activeJoints = [] }: MannequinProps) {
  const rootRef = useRef<Group>(null);
  const lShoulderRef = useRef<Group>(null);
  const lElbowRef = useRef<Group>(null);
  const rShoulderRef = useRef<Group>(null);
  const rElbowRef = useRef<Group>(null);
  const lHipRef = useRef<Group>(null);
  const lKneeRef = useRef<Group>(null);
  const rHipRef = useRef<Group>(null);
  const rKneeRef = useRef<Group>(null);

  const visualUpper = useRef<Record<string, VisualUpper>>({
    l_arm_upper: { elevation: 8, plane: 0 },
    r_arm_upper: { elevation: 8, plane: 0 },
    l_leg_upper: { elevation: 0, plane: 0 },
    r_leg_upper: { elevation: 0, plane: 0 },
  });
  const visualLower = useRef<Record<string, VisualLower>>({
    l_arm_lower: { bend: 5 },
    r_arm_lower: { bend: 5 },
    l_leg_lower: { bend: 0 },
    r_leg_lower: { bend: 0 },
  });
  const velUpper = useRef<Record<string, { e: number; p: number }>>({});
  const velLower = useRef<Record<string, number>>({});

  const shoulderRefs: Record<string, RefObject<Group | null>> = {
    l_arm_upper: lShoulderRef,
    r_arm_upper: rShoulderRef,
    l_leg_upper: lHipRef,
    r_leg_upper: rHipRef,
  };
  const elbowRefs: Record<string, RefObject<Group | null>> = {
    l_arm_lower: lElbowRef,
    r_arm_lower: rElbowRef,
    l_leg_lower: lKneeRef,
    r_leg_lower: rKneeRef,
  };

  useFrame((_, dt) => {
    const capped = Math.min(dt, 0.05);

    for (const key of UPPER_KEYS) {
      const target = frame[key];
      const vis = visualUpper.current[key];
      const vel = velUpper.current[key] ?? { e: 0, p: 0 };

      const accelE = (target.elevation - vis.elevation) * VISUAL_SPRING - vel.e * VISUAL_DAMP;
      const planeDiff = shortestPlaneDelta(vis.plane, target.plane);
      const accelP = planeDiff * VISUAL_SPRING - vel.p * VISUAL_DAMP;
      vel.e += accelE * capped;
      vel.p += accelP * capped;
      vis.elevation += vel.e * capped;
      vis.plane += vel.p * capped;
      velUpper.current[key] = vel;

      const ref = shoulderRefs[key].current;
      if (ref) {
        const isRight = key.startsWith("r_");
        const isLeg = key.includes("leg");
        ref.rotation.order = "YXZ";
        ref.rotation.y = (isRight ? -1 : 1) * vis.plane * DEG;
        ref.rotation.x = -(isLeg ? vis.elevation * 0.95 : vis.elevation) * DEG;
        ref.rotation.z = 0;
      }
    }

    for (const [key, ref] of Object.entries(elbowRefs)) {
      const target = frame[key as keyof SensorFrame];
      if (!("bend" in target)) continue;
      const vis = visualLower.current[key];
      const vel = velLower.current[key] ?? 0;
      const accel = (target.bend - vis.bend) * VISUAL_SPRING - vel * VISUAL_DAMP;
      const newVel = vel + accel * capped;
      vis.bend += newVel * capped;
      velLower.current[key] = newVel;
      if (ref.current) ref.current.rotation.x = -vis.bend * DEG;
    }

    if (rootRef.current) {
      rootRef.current.position.y = 0.02 + Math.sin(performance.now() * 0.0012) * 0.004;
    }
  });

  const isActive = (key: PoseKey) => activeJoints.includes(key);
  const upperArm = SEGMENT_LENGTHS.upperArm;
  const forearm = SEGMENT_LENGTHS.forearm;
  const thigh = SEGMENT_LENGTHS.thigh;
  const shank = SEGMENT_LENGTHS.shank;

  return (
    <group ref={rootRef} position={[0, 0.02, 0]}>
      <mesh position={[0, 1.22, 0]} castShadow>
        <boxGeometry args={[0.36, SEGMENT_LENGTHS.torsoHeight, 0.18]} />
        <meshStandardMaterial color={TORSO} roughness={0.38} metalness={0.08} />
      </mesh>
      <mesh position={[0, 1.58, 0]} castShadow>
        <sphereGeometry args={[0.13, 28, 28]} />
        <meshStandardMaterial color={HEAD} roughness={0.32} metalness={0.05} />
      </mesh>
      <mesh position={[0, 1.02, 0]} castShadow>
        <boxGeometry args={[0.3, 0.12, 0.14]} />
        <meshStandardMaterial color={TORSO} roughness={0.38} metalness={0.08} />
      </mesh>

      <group position={[-SEGMENT_LENGTHS.shoulderWidth, 1.48, 0]}>
        <JointSphere radius={0.052} color={isActive("l_arm_upper") ? ACTIVE : JOINT} />
        <group ref={lShoulderRef}>
          <Limb length={upperArm} radius={0.044} color={isActive("l_arm_upper") ? "#67e8f9" : BODY} />
          <group ref={lElbowRef} position={[0, -upperArm, 0]}>
            <JointSphere radius={0.042} color={isActive("l_arm_lower") ? ACTIVE : JOINT} />
            <Limb length={forearm} radius={0.037} color={isActive("l_arm_lower") ? "#67e8f9" : BODY} />
            <group position={[0, -forearm, 0]}>
              <JointSphere radius={0.034} color={HEAD} />
            </group>
          </group>
        </group>
      </group>

      <group position={[SEGMENT_LENGTHS.shoulderWidth, 1.48, 0]}>
        <JointSphere radius={0.052} color={isActive("r_arm_upper") ? ACTIVE : JOINT} />
        <group ref={rShoulderRef}>
          <Limb length={upperArm} radius={0.044} color={isActive("r_arm_upper") ? "#67e8f9" : BODY} />
          <group ref={rElbowRef} position={[0, -upperArm, 0]}>
            <JointSphere radius={0.042} color={isActive("r_arm_lower") ? ACTIVE : JOINT} />
            <Limb length={forearm} radius={0.037} color={isActive("r_arm_lower") ? "#67e8f9" : BODY} />
            <group position={[0, -forearm, 0]}>
              <JointSphere radius={0.034} color={HEAD} />
            </group>
          </group>
        </group>
      </group>

      <group position={[-SEGMENT_LENGTHS.hipWidth, 0.98, 0]}>
        <JointSphere radius={0.052} color={isActive("l_leg_upper") ? ACTIVE : JOINT} />
        <group ref={lHipRef}>
          <Limb length={thigh} radius={0.054} color={isActive("l_leg_upper") ? "#67e8f9" : BODY} />
          <group ref={lKneeRef} position={[0, -thigh, 0]}>
            <JointSphere radius={0.046} color={isActive("l_leg_lower") ? ACTIVE : JOINT} />
            <Limb length={shank} radius={0.048} color={isActive("l_leg_lower") ? "#67e8f9" : BODY} />
            <group position={[0, -shank, 0]}>
              <JointSphere radius={0.04} color={HEAD} />
            </group>
          </group>
        </group>
      </group>

      <group position={[SEGMENT_LENGTHS.hipWidth, 0.98, 0]}>
        <JointSphere radius={0.052} color={isActive("r_leg_upper") ? ACTIVE : JOINT} />
        <group ref={rHipRef}>
          <Limb length={thigh} radius={0.054} color={isActive("r_leg_upper") ? "#67e8f9" : BODY} />
          <group ref={rKneeRef} position={[0, -thigh, 0]}>
            <JointSphere radius={0.046} color={isActive("r_leg_lower") ? ACTIVE : JOINT} />
            <Limb length={shank} radius={0.048} color={isActive("r_leg_lower") ? "#67e8f9" : BODY} />
            <group position={[0, -shank, 0]}>
              <JointSphere radius={0.034} color={HEAD} />
            </group>
          </group>
        </group>
      </group>
    </group>
  );
}
