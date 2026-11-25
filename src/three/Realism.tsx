import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { skyTexture } from './materials';

/**
 * Rendu réaliste de la visite :
 * - éclairage d'ambiance par une vraie photo HDR d'intérieur (Poly Haven, CC0), aux tons neutres ;
 * - occlusion ambiante (GTAO) : coins, plinthes et dessous de meubles s'assombrissent comme en vrai.
 */
export type HdrPreset = 'apartment';

const hdrCache = new Map<HdrPreset, Promise<THREE.DataTexture>>();
function loadHdr(preset: HdrPreset) {
  if (!hdrCache.has(preset)) hdrCache.set(preset, new EXRLoader().loadAsync(`${import.meta.env.BASE_URL}hdri/${preset}.exr`));
  return hdrCache.get(preset)!;
}

export function HdrEnvironment({ preset, night }: { preset: HdrPreset; night: boolean }) {
  const { gl, scene } = useThree();
  // Repli immédiat (sans téléchargement) pendant le chargement de la photo HDR
  useEffect(() => {
    if (scene.environment) return;
    const pmrem = new THREE.PMREMGenerator(gl);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
  }, [gl, scene]);
  useEffect(() => {
    let alive = true;
    let env: THREE.Texture | null = null;
    loadHdr(preset)
      .then((tex) => {
        if (!alive) return;
        tex.mapping = THREE.EquirectangularReflectionMapping;
        const pmrem = new THREE.PMREMGenerator(gl);
        env = pmrem.fromEquirectangular(tex).texture;
        pmrem.dispose();
        const old = scene.environment;
        scene.environment = env;
        if (old && old !== env) old.dispose();
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [gl, scene, preset]);
  useEffect(() => {
    scene.environmentIntensity = night ? 0.05 : 0.85;
    scene.background = skyTexture(night);
  }, [night, preset, scene]);
  return null;
}

/** Occlusion ambiante + sortie (tons neutres, sRGB). Monté seulement en qualité haute. */
export function PostEffects() {
  const { gl, scene, camera, size } = useThree();
  const dpr = useThree((s) => s.viewport.dpr);
  const composer = useMemo(() => {
    // Rendu intermédiaire antialiasé (MSAA) et en demi-flottant pour garder les hautes lumières
    const rt = new THREE.WebGLRenderTarget(size.width, size.height, { samples: 4, type: THREE.HalfFloatType });
    const c = new EffectComposer(gl, rt);
    c.addPass(new RenderPass(scene, camera));
    const ao = new GTAOPass(scene, camera, size.width, size.height);
    ao.updateGtaoMaterial({ radius: 0.45, distanceExponent: 1, thickness: 1, scale: 1.1, samples: 16, distanceFallOff: 1, screenSpaceRadius: false });
    ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 });
    ao.blendIntensity = 0.9;
    c.addPass(ao);
    c.addPass(new OutputPass());
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, scene, camera]);
  useEffect(() => {
    composer.setPixelRatio(gl.getPixelRatio());
    composer.setSize(size.width, size.height);
  }, [composer, gl, size, dpr]);
  useEffect(() => () => composer.dispose(), [composer]);
  // Priorité 1 : on prend la main sur le rendu de la scène
  useFrame(() => composer.render(), 1);
  return null;
}
