import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';

/**
 * « Photo du projet » : on rend la maquette de l'existant et celle du projet depuis le point de vue
 * de la photo. Là où les deux rendus diffèrent (mur démoli, peinture, nouveau sol, meuble…),
 * on affiche le projet ; ailleurs, on garde la photo réelle.
 */
interface Props {
  photo: string;
  photoAspect: number;
  existing: React.RefObject<THREE.Group | null>;
  project: React.RefObject<THREE.Group | null>;
  /** 0 : photo actuelle, 1 : photo avec les modifications. */
  amount: number;
  exposure: number;
}

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const FRAG = /* glsl */ `
uniform sampler2D tPhoto;
uniform sampler2D tExisting;
uniform sampler2D tProject;
uniform vec2 photoScale;
uniform vec2 texel;
uniform float amount;
uniform float exposure;
uniform bool hasPhoto;
varying vec2 vUv;

// Khronos PBR Neutral (même rendu des tons que la visite)
vec3 neutral(vec3 color) {
  color *= exposure;
  const float startCompression = 0.8 - 0.04;
  const float desaturation = 0.15;
  float x = min(color.r, min(color.g, color.b));
  float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  color -= offset;
  float peak = max(color.r, max(color.g, color.b));
  if (peak < startCompression) return color;
  const float d = 1.0 - startCompression;
  float newPeak = 1.0 - d * d / (peak + d - startCompression);
  color *= newPeak / peak;
  float g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
  return mix(color, vec3(newPeak), g);
}
vec3 toSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
float diffAt(vec2 uv) {
  vec3 e = toSrgb(neutral(texture2D(tExisting, uv).rgb));
  vec3 p = toSrgb(neutral(texture2D(tProject, uv).rgb));
  return length(e - p);
}

void main() {
  // Masque des changements, élargi et adouci pour éviter les bords crénelés
  float m = 0.0;
  for (int i = -2; i <= 2; i++)
    for (int j = -2; j <= 2; j++)
      m = max(m, diffAt(vUv + vec2(float(i), float(j)) * texel * 1.5) * (1.0 - 0.12 * float(abs(i) + abs(j))));
  float mask = smoothstep(0.015, 0.06, m);
  vec3 project = toSrgb(neutral(texture2D(tProject, vUv).rgb));
  vec3 photo = hasPhoto ? texture2D(tPhoto, (vUv - 0.5) * photoScale + 0.5).rgb : toSrgb(neutral(texture2D(tExisting, vUv).rgb));
  gl_FragColor = vec4(mix(photo, project, mask * amount), 1.0);
}
`;

export function PhotoComposite({ photo, photoAspect, existing, project, amount, exposure }: Props) {
  const { gl, scene, camera, size } = useThree();
  const dpr = useThree((s) => s.viewport.dpr);
  const frame = useRef(0);
  const targets = useMemo(() => {
    const opts = { type: THREE.HalfFloatType, samples: 4 } as const;
    return { existing: new THREE.WebGLRenderTarget(1, 1, opts), project: new THREE.WebGLRenderTarget(1, 1, opts) };
  }, []);
  const quad = useMemo(() => {
    const material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      uniforms: {
        tPhoto: { value: null },
        tExisting: { value: targets.existing.texture },
        tProject: { value: targets.project.texture },
        photoScale: { value: new THREE.Vector2(1, 1) },
        texel: { value: new THREE.Vector2(1, 1) },
        amount: { value: 1 },
        exposure: { value: 1 },
        hasPhoto: { value: false },
      },
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    mesh.frustumCulled = false;
    const s = new THREE.Scene();
    s.add(mesh);
    return { scene: s, material, cam: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1) };
  }, [targets]);

  useEffect(() => {
    let alive = true;
    new THREE.TextureLoader().load(photo, (t) => {
      if (!alive) return t.dispose();
      t.colorSpace = THREE.NoColorSpace; // valeurs sRGB brutes, mélangées telles quelles
      const old = quad.material.uniforms.tPhoto.value as THREE.Texture | null;
      quad.material.uniforms.tPhoto.value = t;
      quad.material.uniforms.hasPhoto.value = true;
      old?.dispose();
    });
    return () => {
      alive = false;
    };
  }, [photo, quad]);

  useEffect(() => {
    const w = Math.max(1, Math.round(size.width * dpr));
    const h = Math.max(1, Math.round(size.height * dpr));
    targets.existing.setSize(w, h);
    targets.project.setSize(w, h);
    quad.material.uniforms.texel.value.set(1 / w, 1 / h);
    frame.current = 0;
  }, [size, dpr, targets, quad]);

  useEffect(
    () => () => {
      targets.existing.dispose();
      targets.project.dispose();
      (quad.material.uniforms.tPhoto.value as THREE.Texture | null)?.dispose();
      quad.material.dispose();
    },
    [targets, quad],
  );

  // Priorité 1 : on prend la main sur le rendu. Les deux maquettes ne sont recalculées
  // que de temps en temps (la caméra est fixe), le mélange final à chaque image.
  useFrame(() => {
    const e = existing.current;
    const p = project.current;
    const u = quad.material.uniforms;
    const screen = size.width / size.height;
    // Même cadrage que la photo affichée en « cover »
    if (screen > photoAspect) u.photoScale.value.set(1, photoAspect / screen);
    else u.photoScale.value.set(screen / photoAspect, 1);
    u.amount.value = amount;
    u.exposure.value = exposure;
    if (e && p && frame.current++ % 15 === 0) {
      const tone = gl.toneMapping;
      p.visible = false;
      e.visible = true;
      gl.setRenderTarget(targets.existing);
      gl.render(scene, camera);
      e.visible = false;
      p.visible = true;
      gl.setRenderTarget(targets.project);
      gl.render(scene, camera);
      gl.toneMapping = tone;
    }
    gl.setRenderTarget(null);
    gl.render(quad.scene, quad.cam);
  }, 1);
  return null;
}
