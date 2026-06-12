"use client";

import { useFrame } from "@react-three/fiber";
import { type RefObject, useRef } from "react";
import { Group } from "three";
import { SEGMENT_LENGTHS } from "@/lib/biomechanics";
import { POSE_KEYS, PoseKey } from "@/lib/pose";
import { SensorFrame } from "@/lib/pose-physics";

const DEG = Math.PI / 180;

const BODY = "#7dd3fc";
const JOINT = "#38bdf8";
const HEAD = "#bae6fd";
const TORSO = "#0ea5e9";
const ACTIVE = "#22d3ee";

const VISUAL_SPRING = 18;
const VISUAL_DAMP = 9;

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

  const angles = useRef<Record<PoseKey, number>>(
    Object.fromEntries(POSE_KEYS.map((k) => [k, frame[k].angle])) as Record<PoseKey, number>,
  );
  const velocities = useRef<Record<PoseKey, number>>(
    Object.fromEntries(POSE_KEYS.map((k) => [k, 0])) as Record<PoseKey, number>,
  );

  const jointRefs: Record<PoseKey, RefObject<Group | null>> = {
    l_arm_upper: lShoulderRef,
    l_arm_lower: lElbowRef,
    r_arm_upper: rShoulderRef,
    r_arm_lower: rElbowRef,
    l_leg_upper: lHipRef,
    l_leg_lower: lKneeRef,
    r_leg_upper: rHipRef,
    r_leg_lower: rKneeRef,
  };

  useFrame((_, dt) => {
    const cappedDt = Math.min(dt, 0.05);

    for (const key of POSE_KEYS) {
      const target = frame[key].angle;
      const current = angles.current[key];
      const vel = velocities.current[key];
      const accel = (target - current) * VISUAL_SPRING - vel * VISUAL_DAMP;
      const newVel = vel + accel * cappedDt;
      velocities.current[key] = newVel;
      angles.current[key] = current + newVel * cappedDt;

      const ref = jointRefs[key].current;
      if (ref) {
        ref.rotation.x = -angles.current[key] * DEG;
      }
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

      <group position={[-SEGMENT_LENGTHS.shoulderWidth, 1.48, 0]} rotation={[0, 0, 8 * DEG]}>
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

      <group position={[SEGMENT_LENGTHS.shoulderWidth, 1.48, 0]} rotation={[0, 0, -8 * DEG]}>
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
              <JointSphere radius={0.04} color={HEAD} />
            </group>
          </group>
        </group>
      </group>
    </group>
  );
}
