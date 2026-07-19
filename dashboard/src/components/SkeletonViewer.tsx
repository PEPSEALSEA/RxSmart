"use client";

import { useEffect, useRef } from "react";
import {
  AmbientLight,
  BufferGeometry,
  Color,
  DirectionalLight,
  Float32BufferAttribute,
  GridHelper,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  SphereGeometry,
  Vector3,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { MediaPipeHandSet, MediaPipeLandmark } from "@/lib/mediapipe-pose";
import { HAND_CONNECTIONS, handLandmarksToPoints } from "@/lib/mediapipe-pose";
import {
  LandmarkSmoother,
  POSE_CONNECTIONS,
  landmarksToGroundedPoints,
  type Vec3,
} from "@/lib/skeleton-space";

interface SkeletonViewerProps {
  landmarks: MediaPipeLandmark[] | null;
  /** Prefer metric world landmarks when available. */
  worldLandmarks?: MediaPipeLandmark[] | null;
  hands?: MediaPipeHandSet[] | null;
  skeletonDebug?: boolean;
}

const JOINT_RADIUS = 0.028;
const BONE_COLOR = 0x57534e;
const BONE_DEBUG = 0xfbbf24;
const JOINT_COLOR = 0x78716c;
const JOINT_DEBUG = 0xf59e0b;
const HAND_L = 0x38bdf8;
const HAND_R = 0xfb7185;

function buildBoneLines(
  points: Vec3[],
  connections: ReadonlyArray<readonly [number, number]>,
): Float32Array {
  const verts: number[] = [];
  for (const [a, b] of connections) {
    const pa = points[a];
    const pb = points[b];
    if (!pa || !pb) continue;
    verts.push(pa[0], pa[1], pa[2], pb[0], pb[1], pb[2]);
  }
  return new Float32Array(verts);
}

function syncLineGeometry(line: LineSegments, positions: Float32Array) {
  const geo = line.geometry as BufferGeometry;
  geo.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geo.computeBoundingSphere();
  geo.attributes.position.needsUpdate = true;
}

function syncJointMeshes(group: Group, points: Vec3[], pool: Mesh[]) {
  while (pool.length < points.length) {
    const mesh = new Mesh(
      new SphereGeometry(JOINT_RADIUS, 12, 12),
      new MeshStandardMaterial({
        color: JOINT_COLOR,
        roughness: 0.45,
        metalness: 0.05,
        emissive: new Color(JOINT_COLOR),
        emissiveIntensity: 0.2,
      }),
    );
    pool.push(mesh);
    group.add(mesh);
  }
  for (let i = 0; i < pool.length; i++) {
    const mesh = pool[i];
    const p = points[i];
    if (!p) {
      mesh.visible = false;
      continue;
    }
    mesh.visible = true;
    mesh.position.set(p[0], p[1], p[2]);
  }
}

export default function SkeletonViewer({
  landmarks,
  worldLandmarks = null,
  hands = null,
  skeletonDebug = false,
}: SkeletonViewerProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const propsRef = useRef({ landmarks, worldLandmarks, hands, skeletonDebug });
  propsRef.current = { landmarks, worldLandmarks, hands, skeletonDebug };

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new Scene();
    scene.background = new Color(skeletonDebug ? 0x0a0a0a : 0xfafafa);

    const camera = new PerspectiveCamera(40, 1, 0.05, 40);
    camera.position.set(1.6, 1.35, 2.4);

    const renderer = new WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mount.appendChild(renderer.domElement);

    const ambient = new AmbientLight(0xffffff, skeletonDebug ? 0.9 : 0.7);
    const key = new DirectionalLight(0xffffff, 0.85);
    key.position.set(2.2, 4, 3);
    scene.add(ambient, key);

    const grid = new GridHelper(4, 16, 0xd4d4d4, 0xe5e5e5);
    scene.add(grid);

    const skeletonRoot = new Group();
    scene.add(skeletonRoot);

    const boneMat = new LineBasicMaterial({
      color: skeletonDebug ? BONE_DEBUG : BONE_COLOR,
      transparent: true,
      opacity: 0.95,
    });
    const poseBones = new LineSegments(new BufferGeometry(), boneMat);
    skeletonRoot.add(poseBones);

    const jointGroup = new Group();
    skeletonRoot.add(jointGroup);
    const jointPool: Mesh[] = [];

    const handLBones = new LineSegments(
      new BufferGeometry(),
      new LineBasicMaterial({ color: HAND_L, transparent: true, opacity: 0.95 }),
    );
    const handRBones = new LineSegments(
      new BufferGeometry(),
      new LineBasicMaterial({ color: HAND_R, transparent: true, opacity: 0.95 }),
    );
    skeletonRoot.add(handLBones, handRBones);

    const handLJoints = new Group();
    const handRJoints = new Group();
    skeletonRoot.add(handLJoints, handRJoints);
    const handLPool: Mesh[] = [];
    const handRPool: Mesh[] = [];

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0.95, 0);
    controls.minDistance = 1.2;
    controls.maxDistance = 6;
    controls.maxPolarAngle = Math.PI * 0.49;
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.update();

    const smoother = new LandmarkSmoother(0.4);
    const lookTarget = new Vector3(0, 0.95, 0);

    const resize = () => {
      const w = mount.clientWidth || 1;
      const h = mount.clientHeight || 1;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(mount);

    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const {
        landmarks: lm,
        worldLandmarks: world,
        hands: handSets,
        skeletonDebug: debug,
      } = propsRef.current;

      scene.background = new Color(debug ? 0x0a0a0a : 0xfafafa);
      boneMat.color.setHex(debug ? BONE_DEBUG : BONE_COLOR);

      const source = world && world.length >= 33 ? world : lm;
      const useWorld = Boolean(world && world.length >= 33);

      if (!source || source.length < 33) {
        smoother.reset();
        poseBones.visible = false;
        jointGroup.visible = false;
        handLBones.visible = false;
        handRBones.visible = false;
        handLJoints.visible = false;
        handRJoints.visible = false;
        controls.update();
        renderer.render(scene, camera);
        return;
      }

      const grounded = landmarksToGroundedPoints(source, { worldSpace: useWorld });
      const points = smoother.step(grounded);

      poseBones.visible = true;
      jointGroup.visible = true;
      syncLineGeometry(poseBones, buildBoneLines(points, POSE_CONNECTIONS));
      syncJointMeshes(jointGroup, points, jointPool);

      for (const mesh of jointPool) {
        const mat = mesh.material as MeshStandardMaterial;
        mat.color.setHex(debug ? JOINT_DEBUG : JOINT_COLOR);
        mat.emissive.setHex(debug ? JOINT_DEBUG : JOINT_COLOR);
      }

      const left = handSets?.find((h) => h.label === "Left");
      const right = handSets?.find((h) => h.label === "Right");
      const wristL = points[15];
      const wristR = points[16];

      if (left && wristL) {
        const handScale = useWorld ? 0.55 : 2.2;
        const hp = handLandmarksToPoints(left.landmarks, wristL, handScale);
        handLBones.visible = true;
        handLJoints.visible = true;
        syncLineGeometry(handLBones, buildBoneLines(hp, HAND_CONNECTIONS));
        syncJointMeshes(handLJoints, hp, handLPool);
      } else {
        handLBones.visible = false;
        handLJoints.visible = false;
      }

      if (right && wristR) {
        const handScale = useWorld ? 0.55 : 2.2;
        const hp = handLandmarksToPoints(right.landmarks, wristR, handScale);
        handRBones.visible = true;
        handRJoints.visible = true;
        syncLineGeometry(handRBones, buildBoneLines(hp, HAND_CONNECTIONS));
        syncJointMeshes(handRJoints, hp, handRPool);
      } else {
        handRBones.visible = false;
        handRJoints.visible = false;
      }

      // Keep camera aimed near mid-torso height without chasing every frame jump
      const midY =
        points[11] && points[23]
          ? (points[11][1] + points[23][1]) * 0.5
          : 0.95;
      lookTarget.y += (midY - lookTarget.y) * 0.08;
      controls.target.y = lookTarget.y;
      controls.update();
      renderer.render(scene, camera);
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      poseBones.geometry.dispose();
      boneMat.dispose();
      handLBones.geometry.dispose();
      handRBones.geometry.dispose();
      (handLBones.material as LineBasicMaterial).dispose();
      (handRBones.material as LineBasicMaterial).dispose();
      for (const mesh of [...jointPool, ...handLPool, ...handRPool]) {
        mesh.geometry.dispose();
        (mesh.material as MeshStandardMaterial).dispose();
      }
      if (renderer.domElement.parentElement === mount) {
        mount.removeChild(renderer.domElement);
      }
    };
    // Mount once; props flow via propsRef
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hasPose = Boolean(
    (worldLandmarks && worldLandmarks.length >= 33) ||
      (landmarks && landmarks.length >= 33),
  );

  return (
    <div className="relative h-full min-h-[340px] w-full overflow-hidden rounded-2xl border border-neutral-200/80 bg-neutral-50">
      <div ref={mountRef} className="absolute inset-0" />
      {!hasPose && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <p className="rounded-xl bg-white/90 px-4 py-2 text-xs text-neutral-500 shadow-sm">
            รอ MediaPipe pose — ยืนให้อยู่ในกล้อง
          </p>
        </div>
      )}
      {hasPose && (
        <div className="pointer-events-none absolute bottom-3 left-3 rounded-lg bg-black/50 px-2.5 py-1 text-[10px] text-neutral-200">
          Skeleton · world landmarks · เท้าติดพื้น · ลากหมุน/zoom
        </div>
      )}
    </div>
  );
}
