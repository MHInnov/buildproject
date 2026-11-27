import { useFrame } from '@react-three/fiber';
import { useEffect, useState, type ReactNode, type RefObject } from 'react';
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';

/**
 * Personnage réaliste de la visite (≈ 1,70 m), animé : repos, marche, course.
 * Chargé à la demande ; en attendant, on affiche la silhouette simplifiée.
 */
export const AVATAR_HEIGHT = 1.7;

let cache: Promise<GLTF> | null = null;
const load = () =>
  (cache ??= new GLTFLoader().loadAsync(`${import.meta.env.BASE_URL}models/personnage.glb`).catch((e) => {
    cache = null;
    throw e;
  }));
export const preloadAvatar = load;

interface Rig {
  root: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  idle?: THREE.AnimationAction;
  walk?: THREE.AnimationAction;
  run?: THREE.AnimationAction;
}

export function Avatar({ speed, fallback }: { speed: RefObject<number>; fallback: ReactNode }) {
  const [rig, setRig] = useState<Rig | null>(null);
  useEffect(() => {
    let alive = true;
    load()
      .then((g) => {
        if (!alive) return;
        const root = clone(g.scene);
        root.traverse((o) => {
          o.userData.noCam = true;
          const m = o as THREE.SkinnedMesh;
          if (m.isMesh) {
            m.castShadow = true;
            m.receiveShadow = true;
            // Le maillage animé sort de sa boîte d'origine : on ne le masque jamais par erreur.
            m.frustumCulled = false;
            const mat = m.material as THREE.MeshStandardMaterial;
            // La texture de brillance du modèle est inversée par rapport à la rugosité attendue.
            mat.metalnessMap = null;
            mat.roughnessMap = null;
            mat.metalness = 0;
            mat.roughness = 0.68;
            mat.needsUpdate = true;
          }
        });
        // Taille mesurée sur le squelette (de la plante des pieds au sommet du crâne)
        root.updateMatrixWorld(true);
        const y = (name: string) => root.getObjectByName(name)?.getWorldPosition(new THREE.Vector3()).y;
        const top = y('mixamorigHeadTop_End') ?? y('mixamorigHead');
        const feet = Math.min(...['mixamorigLeftToe_End', 'mixamorigRightToe_End', 'mixamorigLeftFoot', 'mixamorigRightFoot'].map((n) => y(n) ?? Infinity));
        const tall = top !== undefined && Number.isFinite(feet) && top - feet > 0.01 ? top - feet : new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3()).y;
        const sole = Number.isFinite(feet) ? feet - tall * 0.012 : 0;
        const k = AVATAR_HEIGHT / tall;
        const holder = new THREE.Group();
        holder.userData.noCam = true;
        root.scale.multiplyScalar(k);
        root.position.y = -sole * k;
        holder.add(root);
        const mixer = new THREE.AnimationMixer(root);
        const act = (name: string) => {
          const clip = g.animations.find((a) => a.name === name);
          if (!clip) return undefined;
          const a = mixer.clipAction(clip);
          a.play();
          a.setEffectiveWeight(name === 'idle' ? 1 : 0);
          return a;
        };
        setRig({ root: holder, mixer, idle: act('idle'), walk: act('walk'), run: act('run') });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  useFrame((_, dt) => {
    if (!rig) return;
    const v = speed.current ?? 0;
    // Mélange progressif repos / marche / course selon la vitesse
    const target = { idle: v < 0.2 ? 1 : 0, walk: v >= 0.2 && v < 2.2 ? 1 : 0, run: v >= 2.2 ? 1 : 0 };
    const k = Math.min(1, dt * 8);
    for (const key of ['idle', 'walk', 'run'] as const) {
      const a = rig[key];
      if (!a) continue;
      a.setEffectiveWeight(a.getEffectiveWeight() + (target[key] - a.getEffectiveWeight()) * k);
    }
    if (rig.walk) rig.walk.timeScale = Math.max(0.6, v / 1.35);
    if (rig.run) rig.run.timeScale = Math.max(0.8, v / 3.2);
    rig.mixer.update(Math.min(dt, 0.05));
  });

  return rig ? <primitive object={rig.root} /> : <>{fallback}</>;
}
