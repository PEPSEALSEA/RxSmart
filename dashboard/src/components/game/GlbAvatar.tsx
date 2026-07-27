"use client";

import { useGLTF } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Box3,
  Color,
  Group,
  MeshStandardMaterial,
  Object3D,
  SkinnedMesh,
  Vector3,
} from "three";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import {
  ATHLETE_MODEL_URL,
  applyFrameToMixamoBones,
  captureBindPose,
  indexMixamoBones,
  type BindPose,
  type BoneIndex,
} from "@/lib/glb-pose-map";
import { PoseKey } from "@/lib/pose";
import { SensorFrame } from "@/lib/pose-physics";

const TARGET_HEIGHT_M = 1.7;

try {
  useGLTF.preload(ATHLETE_MODEL_URL);
} catch {
  // Preload is best-effort; stage falls back to Mannequin.
}

interface GlbAvatarProps {
  frame: SensorFrame;
  activeJoints?: PoseKey[];
  opacity?: number;
  tint?: string;
  position?: [number, number, number];
  scale?: number;
  ghost?: boolean;
  imuMode?: boolean;
  onReady?: () => void;
  onError?: (error: unknown) => void;
}

function collectSkinnedMeshes(root: Object3D): SkinnedMesh[] {
  const meshes: SkinnedMesh[] = [];
  root.traverse((obj) => {
    if ((obj as SkinnedMesh).isSkinnedMesh) meshes.push(obj as SkinnedMesh);
  });
  return meshes;
}

function heightScaleFromObject(root: Object3D): number {
  const box = new Box3().setFromObject(root);
  const size = new Vector3();
  box.getSize(size);
  if (size.y < 0.05) return 1;
  return TARGET_HEIGHT_M / size.y;
}

export function GlbAvatar({
  frame,
  activeJoints = [],
  opacity = 1,
  tint,
  position = [0, 0, 0],
  scale = 1,
  ghost = false,
  imuMode = false,
  onReady,
  onError,
}: GlbAvatarProps) {
  const gltf = useGLTF(ATHLETE_MODEL_URL);
  const rootRef = useRef<Group>(null);
  const clone = useMemo(() => cloneSkinned(gltf.scene), [gltf.scene]);
  const bonesRef = useRef<BoneIndex>(new Map());
  const bindRef = useRef<BindPose>(new Map());
  const hipsBindY = useRef(0);
  const [autoScale, setAutoScale] = useState(1);
  const readySent = useRef(false);

  useEffect(() => {
    try {
      bonesRef.current = indexMixamoBones(clone);
      bindRef.current = captureBindPose(bonesRef.current);
      const hips = bonesRef.current.get("mixamorigHips");
      hipsBindY.current = hips?.position.y ?? 0;
      setAutoScale(heightScaleFromObject(clone));

      const meshes = collectSkinnedMeshes(clone);
      for (const mesh of meshes) {
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        mesh.material = mats.map((mat) => {
          if (!(mat instanceof MeshStandardMaterial)) return mat;
          const next = mat.clone();
          next.transparent = opacity < 0.99 || ghost;
          next.opacity = opacity;
          next.depthWrite = !ghost;
          if (tint) next.color = new Color(tint);
          if (ghost) {
            next.emissive = new Color(tint ?? "#38bdf8");
            next.emissiveIntensity = 0.45;
          }
          next.needsUpdate = true;
          return next;
        }) as typeof mesh.material;
        mesh.castShadow = !ghost;
        mesh.receiveShadow = !ghost;
        mesh.visible = true;
      }

      if (!readySent.current) {
        readySent.current = true;
        onReady?.();
      }
    } catch (err) {
      onError?.(err);
    }
    // Intentional: notify ready once per clone; parent callbacks may change identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clone, ghost, opacity, tint]);

  useFrame(() => {
    if (bindRef.current.size === 0) return;
    applyFrameToMixamoBones(bonesRef.current, bindRef.current, frame, {
      rootOffsetY: hipsBindY.current,
      imuMode,
    });
  });

  void activeJoints;

  return (
    <group ref={rootRef} position={position} scale={scale * autoScale}>
      <primitive object={clone} />
    </group>
  );
}
