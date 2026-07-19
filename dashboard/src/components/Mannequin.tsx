"use client";

import { useFrame } from "@react-three/fiber";
import { RoundedBox } from "@react-three/drei";
import { type RefObject, useMemo, useRef } from "react";
import { Group, MeshPhysicalMaterial } from "three";
import { SEGMENT_LENGTHS } from "@/lib/biomechanics";
import { applyElbowBend, computeSquatTransform, orientUpperLimb, ROOT_BASE_Y } from "@/lib/mannequin-rig";
import { NEUTRAL_POSE, PoseKey, UPPER_KEYS, shortestPlaneDelta } from "@/lib/pose";
import { SensorFrame } from "@/lib/pose-physics";

const SKIN = "#e8f4fc";
const SKIN_SHADOW = "#c5e4f7";
const ACCENT = "#38bdf8";
const ACTIVE = "#22d3ee";

const VISUAL_SPRING = 16;
const VISUAL_DAMP = 8;
const PELVIS_Y = 0.98;

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

interface MannequinProps {
  frame: SensorFrame;
  activeJoints?: PoseKey[];
}

type VisualUpper = { elevation: number; plane: number };
type VisualLower = { bend: number };
type VisualSquat = { rootY: number; rootZ: number; pelvisLean: number; headCounter: number };

function springScalar(
  current: number,
  target: number,
  velocity: number,
  dt: number,
): { value: number; velocity: number } {
  const accel = (target - current) * VISUAL_SPRING - velocity * VISUAL_DAMP;
  const nextVel = velocity + accel * dt;
  return { value: current + nextVel * dt, velocity: nextVel };
}

export function Mannequin({ frame, activeJoints = [] }: MannequinProps) {
  const rootRef = useRef<Group>(null);
  const pelvisRef = useRef<Group>(null);
  const headRef = useRef<Group>(null);
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
  const visualSquat = useRef<VisualSquat>({
    rootY: ROOT_BASE_Y,
    rootZ: 0,
    pelvisLean: 0,
    headCounter: 0,
  });
  const velUpper = useRef<Record<string, { e: number; p: number }>>({});
  const velLower = useRef<Record<string, number>>({});
  const velSquat = useRef({ rootY: 0, rootZ: 0, pelvisLean: 0, headCounter: 0 });

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
    }

    for (const [key, ref] of Object.entries(elbowRefs)) {
      const target = frame[key as keyof SensorFrame];
      if (!target || typeof target !== "object" || !("bend" in target)) continue;
      const vis = visualLower.current[key];
      const vel = velLower.current[key] ?? 0;
      const accel = (target.bend - vis.bend) * VISUAL_SPRING - vel * VISUAL_DAMP;
      const newVel = vel + accel * capped;
      vis.bend += newVel * capped;
      velLower.current[key] = newVel;
      if (ref.current) applyElbowBend(ref.current, vis.bend);
    }

    const squat = computeSquatTransform(
      {
        elevation: visualUpper.current.l_leg_upper.elevation,
        plane: visualUpper.current.l_leg_upper.plane,
        bend: visualLower.current.l_leg_lower.bend,
      },
      {
        elevation: visualUpper.current.r_leg_upper.elevation,
        plane: visualUpper.current.r_leg_upper.plane,
        bend: visualLower.current.r_leg_lower.bend,
      },
      { mode: frame.body?.mode },
    );

    for (const key of UPPER_KEYS) {
      const ref = shoulderRefs[key].current;
      if (!ref) continue;
      const vis = visualUpper.current[key];
      const isArm = key.includes("arm");
      orientUpperLimb(
        ref,
        key.startsWith("r_"),
        vis.elevation + (isArm ? squat.armElevationOffset : 0),
        vis.plane + (isArm ? squat.armPlaneOffset : 0),
        isArm,
      );
    }

    const vs = visualSquat.current;
    const sv = velSquat.current;
    const breathe = (1 - squat.depth) * Math.sin(performance.now() * 0.0012) * 0.003;

    let next = springScalar(vs.rootY, squat.rootY + breathe, sv.rootY, capped);
    vs.rootY = next.value;
    sv.rootY = next.velocity;

    next = springScalar(vs.rootZ, squat.rootZ, sv.rootZ, capped);
    vs.rootZ = next.value;
    sv.rootZ = next.velocity;

    next = springScalar(vs.pelvisLean, squat.pelvisLeanRad, sv.pelvisLean, capped);
    vs.pelvisLean = next.value;
    sv.pelvisLean = next.velocity;

    next = springScalar(vs.headCounter, squat.headCounterLeanRad, sv.headCounter, capped);
    vs.headCounter = next.value;
    sv.headCounter = next.velocity;

    if (rootRef.current) {
      rootRef.current.position.y = vs.rootY;
      rootRef.current.position.z = vs.rootZ;
    }
    if (pelvisRef.current) {
      pelvisRef.current.rotation.x = vs.pelvisLean;
    }
    if (headRef.current) {
      headRef.current.rotation.x = vs.headCounter;
    }
  });

  const isActive = (key: PoseKey) => activeJoints.includes(key);
  const upperArm = SEGMENT_LENGTHS.upperArm;
  const forearm = SEGMENT_LENGTHS.forearm;
  const thigh = SEGMENT_LENGTHS.thigh;
  const shank = SEGMENT_LENGTHS.shank;

  return (
    <group ref={rootRef} position={[0, ROOT_BASE_Y, 0]}>
      <group ref={pelvisRef} position={[0, PELVIS_Y, 0]}>
        <RoundedBox
          args={[0.28, 0.11, 0.15]}
          radius={0.04}
          smoothness={5}
          position={[0, 0.04, 0]}
          castShadow
          receiveShadow
          material={pelvisMaterial}
        />
        <RoundedBox
          args={[0.34, SEGMENT_LENGTHS.torsoHeight, 0.17]}
          radius={0.055}
          smoothness={6}
          position={[0, 0.28, 0]}
          castShadow
          receiveShadow
          material={torsoMaterial}
        />

        <group ref={headRef} position={[0, 0.46, 0]}>
          <mesh castShadow material={headMaterial}>
            <cylinderGeometry args={[0.048, 0.052, 0.1, 16]} />
          </mesh>
          <mesh position={[0, 0.16, 0.01]} scale={[0.92, 1, 0.88]} castShadow receiveShadow material={headMaterial}>
            <sphereGeometry args={[0.115, 32, 32]} />
          </mesh>
        </group>

        <group position={[-SEGMENT_LENGTHS.shoulderWidth, 0.5, 0]}>
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

        <group position={[SEGMENT_LENGTHS.shoulderWidth, 0.5, 0]}>
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

        <group position={[-SEGMENT_LENGTHS.hipWidth, 0, 0]}>
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

        <group position={[SEGMENT_LENGTHS.hipWidth, 0, 0]}>
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
    </group>
  );
}
