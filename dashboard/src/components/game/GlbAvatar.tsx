"use client";

import { useGLTF } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import {
  Color,
  Group,
  MeshStandardMaterial,
  Object3D,
  SkinnedMesh,
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

useGLTF.preload(ATHLETE_MODEL_URL);

interface GlbAvatarProps {
  frame: SensorFrame;
  activeJoints?: PoseKey[];
  opacity?: number;
  tint?: string;
  position?: [number, number, number];
  scale?: number;
  ghost?: boolean;
}

function collectSkinnedMeshes(root: Object3D): SkinnedMesh[] {
  const meshes: SkinnedMesh[] = [];
  root.traverse((obj) => {
    if ((obj as SkinnedMesh).isSkinnedMesh) meshes.push(obj as SkinnedMesh);
  });
  return meshes;
}

export function GlbAvatar({
  frame,
  activeJoints = [],
  opacity = 1,
  tint,
  position = [0, 0, 0],
  scale = 1,
  ghost = false,
}: GlbAvatarProps) {
  const { scene } = useGLTF(ATHLETE_MODEL_URL);
  const rootRef = useRef<Group>(null);
  const clone = useMemo(() => cloneSkinned(scene), [scene]);
  const bonesRef = useRef<BoneIndex>(new Map());
  const bindRef = useRef<BindPose>(new Map());
  const hipsBindY = useRef(0);

  useEffect(() => {
    bonesRef.current = indexMixamoBones(clone);
    bindRef.current = captureBindPose(bonesRef.current);
    const hips = bonesRef.current.get("mixamorigHips");
    hipsBindY.current = hips?.position.y ?? 0;

    const meshes = collectSkinnedMeshes(clone);
    for (const mesh of meshes) {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      mesh.material = mats.map((mat) => {
        const next = (mat as MeshStandardMaterial).clone();
        next.transparent = opacity < 0.99 || ghost;
        next.opacity = opacity;
        next.depthWrite = !ghost;
        if (tint) next.color = new Color(tint);
        if (ghost) {
          next.emissive = new Color(tint ?? "#38bdf8");
          next.emissiveIntensity = 0.35;
        }
        next.needsUpdate = true;
        return next;
      }) as typeof mesh.material;
      mesh.castShadow = !ghost;
      mesh.receiveShadow = !ghost;
    }
  }, [clone, ghost, opacity, tint]);

  useFrame(() => {
    if (bindRef.current.size === 0) return;
    applyFrameToMixamoBones(bonesRef.current, bindRef.current, frame, {
      rootOffsetY: hipsBindY.current,
    });
  });

  void activeJoints;

  return (
    <group ref={rootRef} position={position} scale={scale}>
      <primitive object={clone} />
    </group>
  );
}
