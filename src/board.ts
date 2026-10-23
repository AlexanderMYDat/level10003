import * as THREE from 'three';
import { patch, NOISE_GLSL, type Textures } from './materials';
import { DOME_R, WORLD_GLSL } from './world';

// ---------- Máscara del suelo ----------
// Cubre el cuadrado [−DOME_R, DOME_R]² a ~0,6 m/píxel. R = micelio (hilos blancos alrededor de los hongos),
// G = sombra de contacto bajo los sombreros. La rellenan los hongos al colocarse.
export const MASK_N = 2048;
const mask = new Uint8Array(MASK_N * MASK_N * 4);
const PX = (2 * DOME_R) / MASK_N;

/** Mancha radial suave en el canal `ch` (máximo con lo que ya había). */
export function stamp(ch: 0 | 1, x: number, z: number, radius: number, strength: number, power = 1.5) {
  const ci = (x + DOME_R) / PX, cj = (z + DOME_R) / PX, rp = radius / PX;
  const i0 = Math.max(0, Math.floor(ci - rp)), i1 = Math.min(MASK_N - 1, Math.ceil(ci + rp));
  const j0 = Math.max(0, Math.floor(cj - rp)), j1 = Math.min(MASK_N - 1, Math.ceil(cj + rp));
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const d = Math.hypot(i + 0.5 - ci, j + 0.5 - cj) / rp;
      if (d >= 1) continue;
      const v = Math.round(255 * strength * (1 - d * d * (3 - 2 * d)) ** power);
      const k = (j * MASK_N + i) * 4 + ch;
      if (v > mask[k]) mask[k] = v;
    }
  }
}

function maskTexture(): THREE.DataTexture {
  const t = new THREE.DataTexture(mask, MASK_N, MASK_N, THREE.RGBAFormat);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

// ---------- Tablero ----------
/**
 * Rejilla de celdas de ~48 m que cubre toda la cúpula (lo que queda fuera lo tapa la pared).
 * No puede ser un solo cuadrilátero: con triángulos de cientos de metros que pasan por detrás
 * de la cámara, la gráfica (Metal) no dibuja nada.
 */
function boardGeometry(): THREE.BufferGeometry {
  const e = DOME_R + 10, n = 25;
  const pos: number[] = [], nrm: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const x = -e + (2 * e * i) / n, z = -e + (2 * e * j) / n;
      pos.push(x, 0, z); nrm.push(0, 1, 0);
      uv.push(x, z);   // UV = (x, z) del mundo: la base tangente coincide con la del shader
    }
  }
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

const BOARD_MAP = /* glsl */ `
  vec2 q = vWPos.xz / FIELD_SQ;   // en casillas
  vec2 cell = floor(q);
  // tablero filtrado: de lejos tiende a la media de blanco y negro (sin moiré)
  vec2 fw = max(fwidth(q), vec2(1e-4));
  vec2 ci = 2.0 * (abs(fract((q - 0.5 * fw) * 0.5) - 0.5) - abs(fract((q + 0.5 * fw) * 0.5) - 0.5)) / fw;
  float dark = 0.5 - 0.5 * ci.x * ci.y;
  // cada casilla es una losa distinta: la textura se gira 0/90/180/270° y se desplaza
  float rk = floor(hash12(cell + 17.0) * 4.0);
  vec2 cs = vec2(cos(rk * 1.5708), sin(rk * 1.5708));
  mat2 R = mat2(cs.x, cs.y, -cs.y, cs.x);
  vec2 p = vWPos.xz / 3.2;
  vec2 uv = R * p + vec2(hash12(cell * 1.7 + 3.0), hash12(cell * 2.3 - 5.0)) * 7.0;
  vec2 dx = R * dFdx(p), dy = R * dFdy(p);
  vec3 cW = textureGrad(map, uv, dx, dy).rgb, cB = textureGrad(uMB, uv, dx, dy).rgb;
  vec3 nW = textureGrad(normalMap, uv, dx, dy).xyz, nB = textureGrad(uMBN, uv, dx, dy).xyz;
  float rW = textureGrad(roughnessMap, uv, dx, dy).g, rB = textureGrad(uMBR, uv, dx, dy).g;
  vec3 col = mix(cW * 0.86, cB, dark) * (0.92 + 0.16 * hash12(cell + 4.0));
  vec3 boardN = mix(nW, nB, dark) * 2.0 - 1.0;
  boardN.xy = boardN.xy * R;                                    // girar también el relieve
  float boardRough = clamp(mix(rW, rB, dark) * 1.3 + 0.04, 0.06, 1.0);
  // juntas de 2 cm entre losas (se apagan a lo lejos)
  vec2 e = min(fract(q), 1.0 - fract(q)) * FIELD_SQ;
  float m = min(e.x, e.y);
  float aa = max(fwidth(m), 0.003) * 1.5;
  float joint = (1.0 - smoothstep(0.01, 0.01 + aa, m)) * (1.0 - smoothstep(0.02, 0.08, max(fw.x, fw.y)));
  col *= 1.0 - 0.6 * joint;
  boardRough = mix(boardRough, 0.9, joint);

  // máscara: micelio (hilos blancos que salen de los hongos) y sombra bajo los sombreros
  vec2 mk = texture2D(uMask, vWPos.xz / (2.0 * DOME_R) + 0.5).rg;
  float near = 1.0 - smoothstep(25.0, 60.0, distance(vWPos, cameraPosition));
  if (mk.r > 0.0 && near > 0.0) {
    vec2 wp = vWPos.xz;
    float w1 = vnoise(wp * 1.3 + vnoise(wp * 0.35) * 3.0), w2 = vnoise(wp * 2.9 - 7.0 + vnoise(wp * 0.6) * 2.0);
    float th = pow(1.0 - abs(w1 * 2.0 - 1.0), 14.0) + 0.6 * pow(1.0 - abs(w2 * 2.0 - 1.0), 18.0);
    float myc = clamp(th, 0.0, 1.0) * smoothstep(0.05, 0.6, mk.r) * near;
    col = mix(col, vec3(0.78, 0.74, 0.68), myc * 0.55);
    boardRough = mix(boardRough, 0.85, myc);
  }
  col *= 1.0 - 0.6 * mk.g;

  // franja de musgo al pie de la pared de la cúpula (la franja verde de la referencia)
  float rad = length(vWPos.xz);
  float mossN = vnoise(vec2(atan(vWPos.z, vWPos.x) * 90.0, 0.0)) * 0.6 + vnoise(vWPos.xz * 0.15) * 0.4;
  float mossW = smoothstep(DOME_R - 22.0 + mossN * 12.0, DOME_R - 8.0 + mossN * 4.0, rad);
  vec2 muv = vWPos.xz / 3.0, mdx = dFdx(muv), mdy = dFdy(muv);   // derivadas fuera del if
  if (mossW > 0.0) {
    vec3 mc = textureGrad(uMoss, muv, mdx, mdy).rgb * vec3(0.42, 0.62, 0.36);
    col = mix(col, mc, mossW);
    boardN = mix(boardN, textureGrad(uMossN, muv, mdx, mdy).xyz * 2.0 - 1.0, mossW);
    boardRough = mix(boardRough, 0.95, mossW);
  }
  diffuseColor.rgb *= col;
`;

/** Reflejo: mármol pulido, sin llegar a espejo. Más fuerte en ángulo rasante; nada en el musgo. */
const BOARD_REFLECT = /* glsl */ `
  float fres = pow(1.0 - clamp(normalize(cameraPosition - vWPos).y, 0.0, 1.0), 5.0);
  float kRefl = uReflOn * (0.07 + 0.3 * fres) * (1.0 - 0.8 * joint) * (1.0 - mossW) * (1.0 - 0.5 * mk.g);
  if (kRefl > 0.0) {
    vec2 ruv = vRefl.xy / vRefl.w + boardN.xy * 0.02;
    outgoingLight = mix(outgoingLight, textureLod(uRefl, ruv, 1.0 + boardRough * 5.0).rgb, kRefl);
  }
  #include <opaque_fragment>
`;

function boardMaterial(T: Textures, refl: FieldReflection, maskTex: THREE.Texture): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    map: T.marbleW.color, normalMap: T.marbleW.normal, roughnessMap: T.marbleW.rough, roughness: 1, metalness: 0,
  });
  return patch(mat, 'chessboard', (s) => {
    Object.assign(s.uniforms, refl.uniforms, {
      uMB: { value: T.marbleB.color }, uMBN: { value: T.marbleB.normal }, uMBR: { value: T.marbleB.rough },
      uMoss: { value: T.moss.color }, uMossN: { value: T.moss.normal }, uMask: { value: maskTex },
    });
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec4 vRefl;\nuniform mat4 uReflMat;')
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vRefl = uReflMat * vec4(vWPos, 1.0);`);
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vWPos;
varying vec4 vRefl;
uniform sampler2D uMB, uMBN, uMBR, uMoss, uMossN, uMask, uRefl;
uniform float uReflOn;
${WORLD_GLSL}
${NOISE_GLSL}`)
      .replace('#include <map_fragment>', BOARD_MAP)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = boardRough;')
      .replace('#include <normal_fragment_maps>', 'vec3 mapN = boardN; mapN.xy *= normalScale; normal = normalize(tbn * mapN);')
      // el cielo ya llega por el reflejo plano: el del mapa de entorno, más flojo.
      // envMapIntensity no sirve: con scene.environment three lo sustituye por scene.environmentIntensity
      .replace('#include <aomap_fragment>', 'reflectedLight.indirectSpecular *= 0.25;\n#include <aomap_fragment>')
      .replace('#include <opaque_fragment>', BOARD_REFLECT);
  });
}

export function buildBoard(T: Textures, reflection: FieldReflection): THREE.Mesh {
  const board = new THREE.Mesh(boardGeometry(), boardMaterial(T, reflection, maskTexture()));
  board.receiveShadow = true;
  return board;
}

// ---------- Reflejo plano ----------
/** Capa de lo que se refleja en el tablero: hongos, cúpula, estrellas, puerta y luces. */
export const REFLECT_LAYER = 1;

/**
 * Reflejo plano del tablero (como Reflector de three, pero dentro del shader del tablero): una cámara
 * simétrica respecto al plano dibuja la capa REFLECT_LAYER a media resolución, con mipmaps para difuminarlo.
 */
export class FieldReflection {
  readonly target = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter,
  });
  readonly uniforms = {
    uRefl: { value: this.target.texture }, uReflMat: { value: new THREE.Matrix4() }, uReflOn: { value: 0 },
  };
  private cam = new THREE.PerspectiveCamera();
  private size = new THREE.Vector2();
  private v = { a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), m: new THREE.Matrix4(), q: new THREE.Vector4(), plane: new THREE.Plane() };

  constructor(private enabled: boolean) {
    this.cam.layers.set(REFLECT_LAYER);
  }

  update(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    const visible = this.enabled && camera.position.y > 0.05;
    this.uniforms.uReflOn.value = visible ? 1 : 0;
    if (!visible) return;
    const { a: view, b: target, c: tmp, m: rot, q, plane } = this.v;
    camera.updateMatrixWorld();

    renderer.getDrawingBufferSize(this.size);
    const w = Math.max(1, Math.round(this.size.x / 2)), h = Math.max(1, Math.round(this.size.y / 2));
    if (this.target.width !== w || this.target.height !== h) this.target.setSize(w, h);

    // cámara simétrica respecto al plano y = 0
    const cam = this.cam;
    view.copy(camera.position).setY(-camera.position.y);
    rot.extractRotation(camera.matrixWorld);
    target.set(0, 0, -1).applyMatrix4(rot).add(camera.position);
    target.y = -target.y;
    cam.position.copy(view);
    cam.up.set(0, 1, 0).applyMatrix4(rot).reflect(tmp.set(0, 1, 0));
    cam.lookAt(target);
    cam.far = camera.far;
    cam.updateMatrixWorld();
    cam.projectionMatrix.copy(camera.projectionMatrix);
    this.uniforms.uReflMat.value.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
      .multiply(cam.projectionMatrix).multiply(cam.matrixWorldInverse);
    // plano de recorte oblicuo: no dibujar lo que queda por debajo del tablero
    plane.setFromNormalAndCoplanarPoint(tmp.set(0, 1, 0), view.set(0, 0, 0)).applyMatrix4(cam.matrixWorldInverse);
    const clip = new THREE.Vector4(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
    const e = cam.projectionMatrix.elements;
    q.set((Math.sign(clip.x) + e[8]) / e[0], (Math.sign(clip.y) + e[9]) / e[5], -1, (1 + e[10]) / e[14]);
    clip.multiplyScalar(2 / clip.dot(q));
    e[2] = clip.x; e[6] = clip.y; e[10] = clip.z + 1; e[14] = clip.w;

    // las sombras se quedan como están: este dibujo solo ve una parte de la escena
    const shadow = renderer.shadowMap.needsUpdate;
    renderer.shadowMap.needsUpdate = false;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    renderer.render(scene, cam);
    renderer.setRenderTarget(prev);
    renderer.shadowMap.needsUpdate = shadow;
  }
}
