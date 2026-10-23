import * as THREE from 'three';

// ---------- Niebla con dispersión hacia la estrella (sustituye la niebla estándar de three) ----------
// Igual que en el Level 94: radial y teñida hacia la luz. Aquí la "luz" es la estrella superior.
export const fogShared = {
  fogSunDir: { value: new THREE.Vector3(0, 1, 0) },
  fogSunColor: { value: new THREE.Color(1, 1, 1) },
};

THREE.ShaderChunk.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vFogDir;
#endif`;
THREE.ShaderChunk.fog_vertex = /* glsl */ `
#ifdef USE_FOG
  vFogDepth = length(mvPosition.xyz);
  vFogDir = transpose(mat3(viewMatrix)) * mvPosition.xyz;
#endif`;
THREE.ShaderChunk.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  uniform vec3 fogSunDir;
  uniform vec3 fogSunColor;
  varying float vFogDepth;
  varying vec3 vFogDir;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
#endif`;
THREE.ShaderChunk.fog_fragment = /* glsl */ `
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
  #else
    float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
  #endif
  float fogSun = pow(max(dot(normalize(vFogDir), fogSunDir), 0.0), 8.0);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, mix(fogColor, fogSunColor, fogSun), fogFactor);
#endif`;

export type Shader = Parameters<THREE.Material['onBeforeCompile']>[0];

/** Conecta la niebla compartida y, opcionalmente, modifica el shader. Cada `key` es un programa distinto. */
export function patch<T extends THREE.Material>(mat: T, key: string, fn?: (s: Shader) => void): T {
  mat.onBeforeCompile = (s) => {
    s.uniforms.fogSunDir = fogShared.fogSunDir;
    s.uniforms.fogSunColor = fogShared.fogSunColor;
    fn?.(s);
  };
  mat.customProgramCacheKey = () => key;
  return mat;
}

export const NOISE_GLSL = /* glsl */ `
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
`;

// ---------- Texturas PBR (CC0: ambientCG) ----------
export interface PBR { color: THREE.Texture; normal: THREE.Texture; rough: THREE.Texture }

export async function loadTextures(manager: THREE.LoadingManager, anisotropy: number) {
  const loader = new THREE.TextureLoader(manager);
  const load = async (path: string, srgb = false) => {
    const t = await loader.loadAsync(path);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = anisotropy;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  const set = async (name: string): Promise<PBR> => {
    const base = `textures/${name}/`;
    const [color, normal, rough] = await Promise.all([load(base + 'color.jpg', true), load(base + 'normal.jpg'), load(base + 'rough.jpg')]);
    return { color, normal, rough };
  };
  const [marbleW, marbleB, moss] = await Promise.all([set('marble_w'), set('marble_b'), set('grass')]);
  return { marbleW, marbleB, moss };
}
export type Textures = Awaited<ReturnType<typeof loadTextures>>;
