import {
  LOWER_KEYS,
  PoseKey,
  PoseTargets,
  ResolvedPose,
  UPPER_KEYS,
  isUpperKey,
  resolvePose,
} from "@/lib/pose";
import { SensorFrame } from "@/lib/pose-physics";
import { RehabExercise } from "@/lib/rehab-exercises";

const STORAGE_KEY = "rxsmart_exercise_pose_overrides";

export type ExercisePoseOverride = {
  exerciseId: string;
  startPose: ResolvedPose;
  phases: Record<string, PoseTargets>;
  capturedAt: number;
};

export type OverrideStore = Record<string, ExercisePoseOverride>;

export function loadOverrideStore(): OverrideStore {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as OverrideStore;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function saveOverride(override: ExercisePoseOverride): void {
  if (typeof window === "undefined") return;
  const store = loadOverrideStore();
  store[override.exerciseId] = override;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

export function clearOverride(exerciseId: string): void {
  if (typeof window === "undefined") return;
  const store = loadOverrideStore();
  delete store[exerciseId];
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

export function getOverride(exerciseId: string): ExercisePoseOverride | null {
  return loadOverrideStore()[exerciseId] ?? null;
}

export function applyExerciseOverride(
  base: RehabExercise,
  override: ExercisePoseOverride | null | undefined,
): RehabExercise {
  if (!override || override.exerciseId !== base.id) return base;
  return {
    ...base,
    startPose: structuredClone(override.startPose),
    phases: base.phases.map((phase) => {
      const captured = override.phases[phase.id];
      if (!captured) return { ...phase, targets: { ...phase.targets } };
      return {
        ...phase,
        targets: { ...phase.targets, ...structuredClone(captured) },
      };
    }),
  };
}

export function frameToResolvedPose(
  frame: SensorFrame,
  planeFallback: ResolvedPose,
  imuMode: boolean,
): ResolvedPose {
  const pose: ResolvedPose = {
    l_arm_upper: {
      elevation: frame.l_arm_upper.elevation,
      plane: imuMode ? planeFallback.l_arm_upper.plane : frame.l_arm_upper.plane,
    },
    r_arm_upper: {
      elevation: frame.r_arm_upper.elevation,
      plane: imuMode ? planeFallback.r_arm_upper.plane : frame.r_arm_upper.plane,
    },
    l_leg_upper: {
      elevation: frame.l_leg_upper.elevation,
      plane: imuMode ? planeFallback.l_leg_upper.plane : frame.l_leg_upper.plane,
    },
    r_leg_upper: {
      elevation: frame.r_leg_upper.elevation,
      plane: imuMode ? planeFallback.r_leg_upper.plane : frame.r_leg_upper.plane,
    },
    l_arm_lower: { bend: frame.l_arm_lower.bend },
    r_arm_lower: { bend: frame.r_arm_lower.bend },
    l_leg_lower: { bend: frame.l_leg_lower.bend },
    r_leg_lower: { bend: frame.r_leg_lower.bend },
  };
  return pose;
}

export function frameToPhaseTargets(
  frame: SensorFrame,
  activeJoints: PoseKey[],
  catalogTargets: PoseTargets,
  planeFallback: ResolvedPose,
  imuMode: boolean,
): PoseTargets {
  const targets: PoseTargets = {};
  const keys = activeJoints.length > 0 ? activeJoints : [...UPPER_KEYS, ...LOWER_KEYS];
  for (const key of keys) {
    if (isUpperKey(key)) {
      const catalog = catalogTargets[key];
      const plane =
        imuMode
          ? (catalog?.plane ?? planeFallback[key].plane)
          : frame[key].plane;
      targets[key] = {
        elevation: frame[key].elevation,
        plane,
      };
    } else {
      targets[key] = { bend: frame[key].bend };
    }
  }
  return targets;
}

export function catalogOverrideFromExercise(exercise: RehabExercise): ExercisePoseOverride {
  const phases: Record<string, PoseTargets> = {};
  for (const phase of exercise.phases) {
    phases[phase.id] = structuredClone(phase.targets);
  }
  return {
    exerciseId: exercise.id,
    startPose: structuredClone(exercise.startPose),
    phases,
    capturedAt: Date.now(),
  };
}

export function captureDefaultStep(
  exercise: RehabExercise,
  frame: SensorFrame,
  imuMode: boolean,
): ResolvedPose {
  return frameToResolvedPose(frame, exercise.startPose, imuMode);
}

export function captureCorrectStep(
  exercise: RehabExercise,
  phaseId: string,
  frame: SensorFrame,
  imuMode: boolean,
  startPose: ResolvedPose,
): PoseTargets {
  const phase = exercise.phases.find((p) => p.id === phaseId);
  if (!phase) return {};
  const planeBase = resolvePose(startPose, phase.targets);
  return frameToPhaseTargets(frame, phase.activeJoints, phase.targets, planeBase, imuMode);
}

export function overrideToBridgePayload(override: ExercisePoseOverride): {
  start_pose: ResolvedPose;
  phases: Record<string, PoseTargets>;
} {
  return {
    start_pose: override.startPose,
    phases: override.phases,
  };
}
