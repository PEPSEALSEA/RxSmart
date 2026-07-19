import {
  LOWER_JOINT_LIMITS,
  ScalarLimit,
  UPPER_JOINT_LIMITS,
  clampScalar,
  clampVelocity,
} from "@/lib/biomechanics";
import { ExercisePhase, RehabExercise } from "@/lib/rehab-exercises";
import {
  LOWER_KEYS,
  NEUTRAL_POSE,
  POSE_KEYS,
  PoseKey,
  ResolvedPose,
  SensorFrame,
  UPPER_KEYS,
  UpperPoseKey,
  isUpperKey,
  normalizePlane,
  resolvePose,
  shortestPlaneDelta,
} from "@/lib/pose";

export type { SensorFrame } from "@/lib/pose";

export type SessionStatus = "idle" | "moving" | "holding" | "rest" | "complete";

export interface UpperJointFeedback {
  elevation: number;
  plane: number;
  targetElevation: number;
  targetPlane: number;
  vElevation: number;
  vPlane: number;
  elevationError: number;
  planeError: number;
  angleOk: boolean;
  velocityOk: boolean;
  isActive: boolean;
}

export interface LowerJointFeedback {
  bend: number;
  targetBend: number;
  vBend: number;
  bendError: number;
  angleOk: boolean;
  velocityOk: boolean;
  isActive: boolean;
}

export type JointFeedback = UpperJointFeedback | LowerJointFeedback;

export interface SessionFeedback {
  score: number;
  messages: string[];
  phaseLabel: string;
  rep: number;
  totalReps: number;
  status: SessionStatus;
  activeJoints: PoseKey[];
  jointFeedback: Record<PoseKey, JointFeedback>;
}

const SPRING_STIFFNESS = 52;
const SPRING_DAMPING = 15;

export function createNeutralFrame(): SensorFrame {
  const { l_arm_upper, r_arm_upper, l_arm_lower, r_arm_lower, l_leg_upper, r_leg_upper, l_leg_lower, r_leg_lower } =
    NEUTRAL_POSE;
  return {
    l_arm_upper: { ...l_arm_upper, vElevation: 0, vPlane: 0 },
    r_arm_upper: { ...r_arm_upper, vElevation: 0, vPlane: 0 },
    l_leg_upper: { ...l_leg_upper, vElevation: 0, vPlane: 0 },
    r_leg_upper: { ...r_leg_upper, vElevation: 0, vPlane: 0 },
    l_arm_lower: { ...l_arm_lower, vBend: 0 },
    r_arm_lower: { ...r_arm_lower, vBend: 0 },
    l_leg_lower: { ...l_leg_lower, vBend: 0 },
    r_leg_lower: { ...r_leg_lower, vBend: 0 },
    body: { rootY: 0.02, rootZ: 0, mode: "standing" },
  };
}

function stepScalar(
  current: number,
  velocity: number,
  target: number,
  lim: ScalarLimit,
  dt: number,
  useShortestPath = false,
): { value: number; velocity: number } {
  const delta = useShortestPath ? shortestPlaneDelta(current, target) : target - current;
  const effectiveTarget = useShortestPath ? current + delta : target;
  const accel = (effectiveTarget - current) * SPRING_STIFFNESS - velocity * SPRING_DAMPING;
  let v = velocity + accel * dt;
  v = Math.min(lim.maxVelocity, Math.max(-lim.maxVelocity, v));
  let value = current + v * dt;
  value = clampScalar(lim, value);
  if (Math.abs(effectiveTarget - value) < 0.35 && Math.abs(v) < 0.5) {
    value = useShortestPath ? normalizePlane(target) : target;
    v = 0;
  }
  return { value, velocity: v };
}

export function stepPhysics(frame: SensorFrame, targets: ResolvedPose, dt: number): SensorFrame {
  const next = createNeutralFrame();

  for (const key of UPPER_KEYS) {
    const lim = UPPER_JOINT_LIMITS[key];
    const cur = frame[key];
    const tgt = targets[key];

    const elev = stepScalar(cur.elevation, cur.vElevation, tgt.elevation, lim.elevation, dt);
    const plane = stepScalar(cur.plane, cur.vPlane, tgt.plane, lim.plane, dt, true);

    next[key] = {
      elevation: elev.value,
      plane: normalizePlane(plane.value),
      vElevation: clampVelocity(lim.elevation, elev.velocity),
      vPlane: clampVelocity(lim.plane, plane.velocity),
    };
  }

  for (const key of LOWER_KEYS) {
    const lim = LOWER_JOINT_LIMITS[key].bend;
    const cur = frame[key];
    const bend = stepScalar(cur.bend, cur.vBend, targets[key].bend, lim, dt);
    next[key] = {
      bend: bend.value,
      vBend: clampVelocity(lim, bend.velocity),
    };
  }

  next.body = frame.body;
  return next;
}

function upperAtTarget(
  frame: SensorFrame,
  targets: ResolvedPose,
  key: UpperPoseKey,
  tolerance?: number,
): boolean {
  const lim = UPPER_JOINT_LIMITS[key];
  const f = frame[key];
  const t = targets[key];
  const tolE = tolerance ?? lim.elevation.tolerance;
  const tolP = tolerance ?? lim.plane.tolerance;
  return (
    Math.abs(f.elevation - t.elevation) <= tolE &&
    Math.abs(shortestPlaneDelta(f.plane, t.plane)) <= tolP
  );
}

function lowerAtTarget(
  frame: SensorFrame,
  targets: ResolvedPose,
  key: (typeof LOWER_KEYS)[number],
  tolerance?: number,
): boolean {
  const lim = LOWER_JOINT_LIMITS[key].bend;
  const tol = tolerance ?? lim.tolerance;
  return Math.abs(frame[key].bend - targets[key].bend) <= tol;
}

function isAtTarget(frame: SensorFrame, targets: ResolvedPose, keys: PoseKey[]): boolean {
  return keys.every((key) =>
    isUpperKey(key) ? upperAtTarget(frame, targets, key) : lowerAtTarget(frame, targets, key),
  );
}

function evaluateUpper(
  frame: SensorFrame,
  targets: ResolvedPose,
  key: UpperPoseKey,
  active: boolean,
  phase: ExercisePhase,
): UpperJointFeedback {
  const lim = UPPER_JOINT_LIMITS[key];
  const f = frame[key];
  const t = targets[key];
  const elevationError = Math.abs(f.elevation - t.elevation);
  const planeError = Math.abs(shortestPlaneDelta(f.plane, t.plane));
  const angleOk =
    !active || (elevationError <= lim.elevation.tolerance && planeError <= lim.plane.tolerance);

  const speed = Math.hypot(f.vElevation, f.vPlane);
  const isHolding = phase.holdSeconds > 0;
  let velocityOk = true;

  if (active && !isHolding && speed > 0.5) {
    velocityOk = speed <= phase.moveSpeed * 1.4 && speed >= lim.elevation.idealVelocityMin * 0.3;
  } else if (active && isHolding) {
    velocityOk = speed < 14;
  }

  return {
    elevation: f.elevation,
    plane: f.plane,
    targetElevation: t.elevation,
    targetPlane: t.plane,
    vElevation: f.vElevation,
    vPlane: f.vPlane,
    elevationError,
    planeError,
    angleOk,
    velocityOk,
    isActive: active,
  };
}

function evaluateLower(
  frame: SensorFrame,
  targets: ResolvedPose,
  key: (typeof LOWER_KEYS)[number],
  active: boolean,
  phase: ExercisePhase,
): LowerJointFeedback {
  const lim = LOWER_JOINT_LIMITS[key].bend;
  const f = frame[key];
  const t = targets[key];
  const bendError = Math.abs(f.bend - t.bend);
  const angleOk = !active || bendError <= lim.tolerance;
  const speed = Math.abs(f.vBend);
  const isHolding = phase.holdSeconds > 0;
  let velocityOk = true;

  if (active && !isHolding && speed > 0.5) {
    velocityOk = speed <= phase.moveSpeed * 1.35 && speed >= lim.idealVelocityMin * 0.35;
  } else if (active && isHolding) {
    velocityOk = speed < 12;
  }

  return {
    bend: f.bend,
    targetBend: t.bend,
    vBend: f.vBend,
    bendError,
    angleOk,
    velocityOk,
    isActive: active,
  };
}

export function buildSessionFeedback(
  frame: SensorFrame,
  targets: ResolvedPose,
  phase: ExercisePhase,
  rep: number,
  totalReps: number,
  status: SessionStatus,
): SessionFeedback {
  const jointFeedback = {} as Record<PoseKey, JointFeedback>;
  let activeCount = 0;
  let passCount = 0;

  for (const key of POSE_KEYS) {
    const active = phase.activeJoints.includes(key);
    const fb = isUpperKey(key)
      ? evaluateUpper(frame, targets, key, active, phase)
      : evaluateLower(frame, targets, key, active, phase);
    jointFeedback[key] = fb;
    if (active) {
      activeCount++;
      if (fb.angleOk && fb.velocityOk) passCount++;
    }
  }

  const messages: string[] = [];
  const score = activeCount === 0 ? 100 : Math.round((passCount / activeCount) * 100);

  if (status === "holding") {
    messages.push("ค้างท่า — รักษามุม elevation + plane ให้คงที่");
  } else if (status === "moving") {
    const hasCirc = phase.activeJoints.some((k) => isUpperKey(k));
    if (hasCirc) {
      messages.push("หมุนข้อต่อรอบทิศ — ควบคุมทั้งยกขึ้นและทิศทาง (plane)");
    }
    if (messages.length === 0) {
      messages.push("ความเร็วและมุมเหมาะสม — ทำต่อได้เลย");
    }
  } else if (status === "rest") {
    messages.push("พักระหว่าง rep");
  } else if (status === "complete") {
    messages.push("เสร็จโปรแกรมแล้ว!");
  } else {
    messages.push("กดเริ่มเพื่อฝึก — ข้อต่อบนมี 2 แก่ (ยก + หมุนรอบตัว)");
  }

  return {
    score,
    messages: messages.slice(0, 3),
    phaseLabel: phase.label,
    rep,
    totalReps,
    status,
    activeJoints: phase.activeJoints,
    jointFeedback,
  };
}

export class RehabSessionEngine {
  private exercise: RehabExercise;
  private targets: ResolvedPose;
  private phaseIndex = 0;
  private rep = 1;
  private phaseElapsed = 0;
  private restRemaining = 0;
  private status: SessionStatus = "idle";
  private running = false;

  constructor(exercise: RehabExercise) {
    this.exercise = exercise;
    this.targets = { ...exercise.startPose };
  }

  getTargets(): ResolvedPose {
    return structuredClone(this.targets);
  }

  getStatus(): SessionStatus {
    return this.status;
  }

  getPhase(): ExercisePhase {
    return this.exercise.phases[this.phaseIndex];
  }

  start(): void {
    this.running = true;
    this.status = "moving";
    this.phaseIndex = 0;
    this.rep = 1;
    this.phaseElapsed = 0;
    this.targets = resolvePose(this.exercise.startPose, this.getPhase().targets);
  }

  stop(): void {
    this.running = false;
    this.status = "idle";
    this.targets = structuredClone(this.exercise.startPose);
  }

  reset(): void {
    this.stop();
    this.phaseIndex = 0;
    this.rep = 1;
    this.phaseElapsed = 0;
    this.restRemaining = 0;
  }

  setExercise(exercise: RehabExercise): void {
    this.exercise = exercise;
    this.reset();
    this.targets = structuredClone(exercise.startPose);
  }

  tick(dt: number, frame: SensorFrame): SessionFeedback {
    const phase = this.getPhase();

    if (!this.running) {
      return buildSessionFeedback(frame, this.targets, phase, this.rep, this.exercise.reps, "idle");
    }

    if (this.restRemaining > 0) {
      this.restRemaining = Math.max(0, this.restRemaining - dt);
      this.status = "rest";
      this.targets = structuredClone(this.exercise.startPose);
      if (this.restRemaining === 0) {
        this.status = "moving";
        this.targets = resolvePose(this.exercise.startPose, this.getPhase().targets);
      }
      return buildSessionFeedback(frame, this.targets, phase, this.rep, this.exercise.reps, this.status);
    }

    this.targets = resolvePose(this.exercise.startPose, phase.targets);
    this.phaseElapsed += dt;
    const atTarget = isAtTarget(frame, this.targets, phase.activeJoints);

    if (phase.holdSeconds > 0) {
      this.status = atTarget ? "holding" : "moving";
      if (atTarget && this.phaseElapsed >= phase.holdSeconds) this.advancePhase();
    } else if (atTarget) {
      this.advancePhase();
    } else {
      this.status = "moving";
    }

    return buildSessionFeedback(frame, this.targets, phase, this.rep, this.exercise.reps, this.status);
  }

  private advancePhase(): void {
    this.phaseElapsed = 0;
    const last = this.exercise.phases.length - 1;

    if (this.phaseIndex < last) {
      this.phaseIndex++;
      this.status = "moving";
      this.targets = resolvePose(this.exercise.startPose, this.getPhase().targets);
      return;
    }

    if (this.rep < this.exercise.reps) {
      this.rep++;
      this.phaseIndex = 0;
      this.status = "rest";
      this.restRemaining = this.exercise.restBetweenReps;
      this.targets = structuredClone(this.exercise.startPose);
      return;
    }

    this.running = false;
    this.status = "complete";
  }
}
