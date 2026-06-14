"use client";

import { useFrame } from "@react-three/fiber";
import { RoundedBox } from "@react-three/drei";
import { type RefObject, useMemo, useRef } from "react";
import { Group, MeshPhysicalMaterial, Vector3 } from "three";
import { SEGMENT_LENGTHS } from "@/lib/biomechanics";
import { NEUTRAL_POSE, PoseKey, UPPER_KEYS, UpperPoseKey, LowerPoseKey, shortestPlaneDelta, visualArmDirection, upperLimbDirection } from "@/lib/pose";
import { SensorFrame } from "@/lib/pose-physics";

const DEG = Math.PI / 180;
const BIND_AXIS = new Vector3(0, -1, 0);
const FLIP_AXIS = new Vector3(1, 0, 0);
const _targetDir = new Vector3();

const SKIN = "#e8f4fc";
const SKIN_SHADOW = "#c5e4f7";
const ACCENT = "#38bdf8";
const ACTIVE = "#22d3ee";

const VISUAL_SPRING = 16;
const VISUAL_DAMP = 8;

function useBodyMaterial(color: string, active: boolean) {
  return useMemo(
    () =>
      new MeshPhysicalMaterial({
        color: active ? "#a5f3fc" : color,
        roughness: 0.48,
        metalness: 0.02,
        clearcoat: 0.35,
        clearcoatRoughness: 0.22,
        emissive: active ? ACTIVE : "#000000",
        emissiveIntensity: active ? 0.22 : 0,
      }),
    [color, active],
  );
}

function TaperedLimb({
  length,
  radiusTop,
  radiusBottom,
  color,
  active,
}: {
  length: number;
  radiusTop: number;
  radiusBottom: number;
  color: string;
  active: boolean;
}) {
  const material = useBodyMaterial(color, active);
  return (
    <mesh position={[0, -length / 2, 0]} castShadow receiveShadow material={material}>
      <cylinderGeometry args={[radiusTop, radiusBottom, length, 20, 1]} />
    </mesh>
  );
}

function Joint({ radius, active }: { radius: number; active: boolean }) {
  const material = useBodyMaterial(SKIN_SHADOW, active);
  return (
    <mesh castShadow material={material}>
      <sphereGeometry args={[radius, 16, 16]} />
    </mesh>
  );
}

function Hand({ active }: { active?: boolean }) {
  const material = useBodyMaterial(SKIN, !!active);
  return (
    <mesh position={[0, -0.028, 0.01]} rotation={[0.15, 0, 0]} castShadow material={material}>
      <boxGeometry args={[0.052, 0.06, 0.028]} />
    </mesh>
  );
}

function Foot({ active }: { active?: boolean }) {
  const material = useBodyMaterial(SKIN_SHADOW, !!active);
  return (
    <mesh position={[0, -0.02, 0.04]} castShadow material={material}>
      <boxGeometry args={[0.07, 0.04, 0.14]} />
    </mesh>
  );
}

function applyUpperOrientation(
  group: Group,
  isRight: boolean,
  isArm: boolean,
  elevation: number,
  plane: number,
  elbowBend = 0,
) {
  const [x, y, z] = isArm
    ? visualArmDirection(isRight, elevation, plane, elbowBend)
    : upperLimbDirection(isRight, elevation, plane);
  _targetDir.set(x, y, z);
  const dot = BIND_AXIS.dot(_targetDir);

  if (dot > 0.9999) {
    group.quaternion.identity();
    return;
  }
  if (dot < -0.9999) {
    group.quaternion.setFromAxisAngle(FLIP_AXIS, Math.PI);
    return;
  }
  group.quaternion.setFromUnitVectors(BIND_AXIS, _targetDir);
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

  const torsoMaterial = useBodyMaterial(ACCENT, false);
  const headMaterial = useBodyMaterial(SKIN, false);
  const pelvisMaterial = useBodyMaterial(SKIN_SHADOW, false);

  const visualUpper = useRef<Record<string, VisualUpper>>({
    l_arm_upper: { ...NEUTRAL_POSE.l_arm_upper },
    r_arm_upper: { ...NEUTRAL_POSE.r_arm_upper },
    l_leg_upper: { ...NEUTRAL_POSE.l_leg_upper },
    r_leg_upper: { ...NEUTRAL_POSE.r_leg_upper },
  });
  const visualLower = useRef<Record<string, VisualLower>>({
    l_arm_lower: { ...NEUTRAL_POSE.l_arm_lower },
    r_arm_lower: { ...NEUTRAL_POSE.r_arm_lower },
    l_leg_lower: { ...NEUTRAL_POSE.l_leg_lower },
    r_leg_lower: { ...NEUTRAL_POSE.r_leg_lower },
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
  const upperToLower: Partial<Record<UpperPoseKey, LowerPoseKey>> = {
    l_arm_upper: "l_arm_lower",
    r_arm_upper: "r_arm_lower",
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
        const isArm = key.includes("arm");
        const lowerKey = upperToLower[key as UpperPoseKey];
        const elbowBend = isArm && lowerKey ? visualLower.current[lowerKey].bend : 0;
        applyUpperOrientation(ref, key.startsWith("r_"), isArm, vis.elevation, vis.plane, elbowBend);
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
      rootRef.current.position.y = 0.02 + Math.sin(performance.now() * 0.0012) * 0.003;
    }
  });

  const isActive = (key: PoseKey) => activeJoints.includes(key);
  const upperArm = SEGMENT_LENGTHS.upperArm;
  const forearm = SEGMENT_LENGTHS.forearm;
  const thigh = SEGMENT_LENGTHS.thigh;
  const shank = SEGMENT_LENGTHS.shank;

  return (
    <group ref={rootRef} position={[0, 0.02, 0]}>
      <RoundedBox
        args={[0.34, SEGMENT_LENGTHS.torsoHeight, 0.17]}
        radius={0.055}
        smoothness={6}
        position={[0, 1.22, 0]}
        castShadow
        receiveShadow
        material={torsoMaterial}
      />
      <RoundedBox
        args={[0.28, 0.11, 0.15]}
        radius={0.04}
        smoothness={5}
        position={[0, 1.02, 0]}
        castShadow
        receiveShadow
        material={pelvisMaterial}
      />

      <mesh position={[0, 1.44, 0]} castShadow material={headMaterial}>
        <cylinderGeometry args={[0.048, 0.052, 0.1, 16]} />
      </mesh>
      <mesh position={[0, 1.6, 0.01]} scale={[0.92, 1, 0.88]} castShadow receiveShadow material={headMaterial}>
        <sphereGeometry args={[0.115, 32, 32]} />
      </mesh>

      <group position={[-SEGMENT_LENGTHS.shoulderWidth, 1.48, 0.04]}>
        <Joint radius={0.038} active={isActive("l_arm_upper")} />
        <group ref={lShoulderRef}>
          <TaperedLimb
            length={upperArm}
            radiusTop={0.048}
            radiusBottom={0.04}
            color={SKIN}
            active={isActive("l_arm_upper")}
          />
          <group ref={lElbowRef} position={[0, -upperArm, 0]}>
            <Joint radius={0.034} active={isActive("l_arm_lower")} />
            <TaperedLimb
              length={forearm}
              radiusTop={0.04}
              radiusBottom={0.032}
              color={SKIN}
              active={isActive("l_arm_lower")}
            />
            <group position={[0, -forearm, 0]}>
              <Hand active={isActive("l_arm_lower")} />
            </group>
          </group>
        </group>
      </group>

      <group position={[SEGMENT_LENGTHS.shoulderWidth, 1.48, 0.04]}>
        <Joint radius={0.038} active={isActive("r_arm_upper")} />
        <group ref={rShoulderRef}>
          <TaperedLimb
            length={upperArm}
            radiusTop={0.048}
            radiusBottom={0.04}
            color={SKIN}
            active={isActive("r_arm_upper")}
          />
          <group ref={rElbowRef} position={[0, -upperArm, 0]}>
            <Joint radius={0.034} active={isActive("r_arm_lower")} />
            <TaperedLimb
              length={forearm}
              radiusTop={0.04}
              radiusBottom={0.032}
              color={SKIN}
              active={isActive("r_arm_lower")}
            />
            <group position={[0, -forearm, 0]}>
              <Hand active={isActive("r_arm_lower")} />
            </group>
          </group>
        </group>
      </group>

      <group position={[-SEGMENT_LENGTHS.hipWidth, 0.98, 0]}>
        <Joint radius={0.042} active={isActive("l_leg_upper")} />
        <group ref={lHipRef}>
          <TaperedLimb
            length={thigh}
            radiusTop={0.058}
            radiusBottom={0.05}
            color={SKIN}
            active={isActive("l_leg_upper")}
          />
          <group ref={lKneeRef} position={[0, -thigh, 0]}>
            <Joint radius={0.038} active={isActive("l_leg_lower")} />
            <TaperedLimb
              length={shank}
              radiusTop={0.05}
              radiusBottom={0.038}
              color={SKIN_SHADOW}
              active={isActive("l_leg_lower")}
            />
            <group position={[0, -shank, 0]}>
              <Foot active={isActive("l_leg_lower")} />
            </group>
          </group>
        </group>
      </group>

      <group position={[SEGMENT_LENGTHS.hipWidth, 0.98, 0]}>
        <Joint radius={0.042} active={isActive("r_leg_upper")} />
        <group ref={rHipRef}>
          <TaperedLimb
            length={thigh}
            radiusTop={0.058}
            radiusBottom={0.05}
            color={SKIN}
            active={isActive("r_leg_upper")}
          />
          <group ref={rKneeRef} position={[0, -thigh, 0]}>
            <Joint radius={0.038} active={isActive("r_leg_lower")} />
            <TaperedLimb
              length={shank}
              radiusTop={0.05}
              radiusBottom={0.038}
              color={SKIN_SHADOW}
              active={isActive("r_leg_lower")}
            />
            <group position={[0, -shank, 0]}>
              <Foot active={isActive("r_leg_lower")} />
            </group>
          </group>
        </group>
      </group>
    </group>
  );
}
