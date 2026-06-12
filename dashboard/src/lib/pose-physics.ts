import { clampAngle, clampVelocity, JOINT_LIMITS } from "@/lib/biomechanics";
import { ExercisePhase, RehabExercise } from "@/lib/rehab-exercises";
import { NEUTRAL_POSE, POSE_KEYS, PoseAngles, PoseKey } from "@/lib/pose";

export interface SensorReading {
  angle: number;
  velocity: number;
}

export type SensorFrame = Record<PoseKey, SensorReading>;

export type SessionStatus = "idle" | "moving" | "holding" | "rest" | "complete";

export interface JointFeedback {
  angle: number;
  velocity: number;
  target: number;
  angleError: number;
  angleOk: boolean;
  velocityOk: boolean;
  isActive: boolean;
}

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
  const frame = {} as SensorFrame;
  for (const key of POSE_KEYS) {
    frame[key] = { angle: JOINT_LIMITS[key].rest, velocity: 0 };
  }
  return frame;
}

export function frameToAngles(frame: SensorFrame): PoseAngles {
  const angles = {} as PoseAngles;
  for (const key of POSE_KEYS) {
    angles[key] = frame[key].angle;
  }
  return angles;
}

export function anglesToFrame(angles: PoseAngles, prev?: SensorFrame): SensorFrame {
  const frame = {} as SensorFrame;
  for (const key of POSE_KEYS) {
    frame[key] = {
      angle: clampAngle(key, angles[key]),
      velocity: prev?.[key].velocity ?? 0,
    };
  }
  return frame;
}

function resolveTargets(base: PoseAngles, partial: Partial<PoseAngles>): PoseAngles {
  const result = { ...base };
  for (const key of POSE_KEYS) {
    if (partial[key] !== undefined) {
      result[key] = partial[key]!;
    }
  }
  return result;
}

/** Spring-damper physics — จำลองการเคลื่อนไหวของร่างกายจริง */
export function stepPhysics(
  frame: SensorFrame,
  targets: PoseAngles,
  dt: number,
  maxSpeedScale = 1,
): SensorFrame {
  const next = {} as SensorFrame;

  for (const key of POSE_KEYS) {
    const lim = JOINT_LIMITS[key];
    const current = frame[key];
    const target = clampAngle(key, targets[key]);

    let accel = (target - current.angle) * SPRING_STIFFNESS - current.velocity * SPRING_DAMPING;

    const maxSpeed = lim.maxVelocity * maxSpeedScale;
    let velocity = current.velocity + accel * dt;
    velocity = Math.min(maxSpeed, Math.max(-maxSpeed, velocity));

    let angle = current.angle + velocity * dt;
    angle = clampAngle(key, angle);

    if (Math.abs(target - angle) < 0.3 && Math.abs(velocity) < 0.5) {
      angle = target;
      velocity = 0;
    }

    next[key] = { angle, velocity: clampVelocity(key, velocity) };
  }

  return next;
}

function isAtTarget(frame: SensorFrame, targets: PoseAngles, keys: PoseKey[], tolerance = 5): boolean {
  return keys.every((key) => Math.abs(frame[key].angle - targets[key]) <= tolerance);
}

export function evaluateJoint(
  frame: SensorFrame,
  targets: PoseAngles,
  key: PoseKey,
  active: boolean,
  phase: ExercisePhase,
): JointFeedback {
  const lim = JOINT_LIMITS[key];
  const reading = frame[key];
  const target = targets[key];
  const angleError = Math.abs(reading.angle - target);
  const angleOk = !active || angleError <= lim.tolerance;

  const speed = Math.abs(reading.velocity);
  const isHolding = phase.holdSeconds > 0;
  let velocityOk = true;

  if (active && !isHolding && speed > 0.5) {
    velocityOk = speed <= phase.moveSpeed * 1.35 && speed >= lim.idealVelocityMin * 0.35;
  } else if (active && isHolding) {
    velocityOk = speed < 12;
  }

  return {
    angle: reading.angle,
    velocity: reading.velocity,
    target,
    angleError,
    angleOk,
    velocityOk,
    isActive: active,
  };
}

export function buildSessionFeedback(
  frame: SensorFrame,
  targets: PoseAngles,
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
    const fb = evaluateJoint(frame, targets, key, active, phase);
    jointFeedback[key] = fb;
    if (active) {
      activeCount++;
      if (fb.angleOk && fb.velocityOk) passCount++;
    }
  }

  const messages: string[] = [];
  const score = activeCount === 0 ? 100 : Math.round((passCount / activeCount) * 100);

  if (status === "holding") {
    const worst = phase.activeJoints
      .map((k) => jointFeedback[k])
      .sort((a, b) => b.angleError - a.angleError)[0];
    if (worst && !worst.angleOk) {
      messages.push(`ปรับมุมเพิ่มอีก ${worst.angleError.toFixed(0)}° ให้ถึงเป้า`);
    } else if (worst && !worst.velocityOk) {
      messages.push("ค้างท่าให้นิ่งขึ้น — ลดการสั่น");
    } else {
      messages.push("ค้างท่าได้ดี — คงไว้อีกนิด");
    }
  } else if (status === "moving") {
    for (const key of phase.activeJoints) {
      const fb = jointFeedback[key];
      const lim = JOINT_LIMITS[key];
      const speed = Math.abs(fb.velocity);
      if (speed > lim.maxVelocity * 0.85) {
        messages.push(`${limLabel(key)}: เร็วเกินไป — ช้าลง`);
      } else if (speed > 0.5 && speed < lim.idealVelocityMin * 0.4) {
        messages.push(`${limLabel(key)}: ช้าเกินไป — ค่อยๆ ยกขึ้น`);
      }
    }
    if (messages.length === 0) {
      messages.push("ความเร็วและมุมเหมาะสม — ทำต่อได้เลย");
    }
  } else if (status === "rest") {
    messages.push("พักระหว่าง rep — เตรียมรอบถัดไป");
  } else if (status === "complete") {
    messages.push("เสร็จโปรแกรมแล้ว — ดีมาก!");
  } else {
    messages.push("กดเริ่มเพื่อฝึกท่านี้");
  }

  return {
    score,
    messages: [...new Set(messages)].slice(0, 3),
    phaseLabel: phase.label,
    rep,
    totalReps,
    status,
    activeJoints: phase.activeJoints,
    jointFeedback,
  };
}

function limLabel(key: PoseKey): string {
  const map: Record<PoseKey, string> = {
    l_arm_upper: "ไหล่ซ้าย",
    l_arm_lower: "ข้อศอกซ้าย",
    r_arm_upper: "ไหล่ขวา",
    r_arm_lower: "ข้อศอกขวา",
    l_leg_upper: "สะโพกซ้าย",
    l_leg_lower: "เข่าซ้าย",
    r_leg_upper: "สะโพกขวา",
    r_leg_lower: "เข่าขวา",
  };
  return map[key];
}

export class RehabSessionEngine {
  private exercise: RehabExercise;
  private targets: PoseAngles;
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

  getTargets(): PoseAngles {
    return { ...this.targets };
  }

  getStatus(): SessionStatus {
    return this.status;
  }

  getRep(): number {
    return this.rep;
  }

  getPhase(): ExercisePhase {
    return this.exercise.phases[this.phaseIndex];
  }

  isRunning(): boolean {
    return this.running;
  }

  start(): void {
    this.running = true;
    this.status = "moving";
    this.phaseIndex = 0;
    this.rep = 1;
    this.phaseElapsed = 0;
    this.targets = resolveTargets(this.exercise.startPose, this.getPhase().targets);
  }

  stop(): void {
    this.running = false;
    this.status = "idle";
    this.targets = { ...this.exercise.startPose };
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
    this.targets = { ...exercise.startPose };
  }

  tick(dt: number, frame: SensorFrame): SessionFeedback {
    const phase = this.getPhase();

    if (!this.running) {
      return buildSessionFeedback(frame, this.targets, phase, this.rep, this.exercise.reps, "idle");
    }

    if (this.restRemaining > 0) {
      this.restRemaining = Math.max(0, this.restRemaining - dt);
      this.status = "rest";
      this.targets = { ...this.exercise.startPose };
      if (this.restRemaining === 0) {
        this.status = "moving";
        this.targets = resolveTargets(this.exercise.startPose, this.getPhase().targets);
      }
      return buildSessionFeedback(
        frame,
        this.targets,
        phase,
        this.rep,
        this.exercise.reps,
        this.status,
      );
    }

    this.targets = resolveTargets(this.exercise.startPose, phase.targets);
    this.phaseElapsed += dt;

    const atTarget = isAtTarget(frame, this.targets, phase.activeJoints);

    if (phase.holdSeconds > 0) {
      if (!atTarget) {
        this.status = "moving";
      } else {
        this.status = "holding";
        if (this.phaseElapsed >= phase.holdSeconds) {
          this.advancePhase();
        }
      }
    } else if (atTarget) {
      this.advancePhase();
    } else {
      this.status = "moving";
    }

    return buildSessionFeedback(
      frame,
      this.targets,
      phase,
      this.rep,
      this.exercise.reps,
      this.status,
    );
  }

  private advancePhase(): void {
    this.phaseElapsed = 0;
    const lastPhase = this.exercise.phases.length - 1;

    if (this.phaseIndex < lastPhase) {
      this.phaseIndex++;
      this.status = "moving";
      this.targets = resolveTargets(this.exercise.startPose, this.getPhase().targets);
      return;
    }

    if (this.rep < this.exercise.reps) {
      this.rep++;
      this.phaseIndex = 0;
      this.status = "rest";
      this.restRemaining = this.exercise.restBetweenReps;
      this.targets = { ...this.exercise.startPose };
      return;
    }

    this.running = false;
    this.status = "complete";
  }
}
