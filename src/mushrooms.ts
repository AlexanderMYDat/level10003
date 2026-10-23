import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { patch, NOISE_GLSL } from './materials';
import { mulberry32, lerp } from './noise';
import { stamp } from './board';
import { DOME_R, DOOR_POS, SPAWN } from './world';

// ---------- Hongos rojos ----------
// Cada hongo se genera por torno (LatheGeometry): pie con bulbo en la base, anillo opcional, sombrero
// (de campana a parasol) y láminas debajo. El pie se curva y el sombrero sigue la curva.
// Se fusionan por bloques de 200 m y por material (sombrero / carne): pocas llamadas de dibujo.

export interface Shroom {
  x: number; z: number;
  H: number;                  // altura total (m)
  capR: number; capH: number; // radio y grosor del sombrero
  bell: number;               // forma: 1 = cúpula, 2,2 = parasol con el borde caído
  stemR: number;
  bx: number; bz: number;     // desplazamiento de la punta del pie (curvatura)
  tilt: THREE.Quaternion;     // giro extra del sombrero
  ring: boolean;
  cap: THREE.Color; flesh: THREE.Color;
  yaw: number;
  tiny: boolean;              // brotes: sin colisión, menos detalle
}

const CHUNK = 100;

function randomShroom(rand: () => number, x: number, z: number, H: number, tiny = false): Shroom {
  const capR = H * lerp(0.3, 0.46, rand()) * (tiny ? 1.15 : 1);
  const lean = H * 0.12 * rand() ** 1.5, la = rand() * Math.PI * 2;
  const ax = new THREE.Vector3(rand() - 0.5, 0, rand() - 0.5).normalize();
  // rojos de carmín a bermellón; algunos muy oscuros, casi granate
  const cap = new THREE.Color().setHSL(lerp(0.978, 1.008, rand()) % 1, lerp(0.82, 0.95, rand()), lerp(0.27, 0.4, rand()));
  if (rand() < 0.12) cap.multiplyScalar(0.6);
  return {
    x, z, H, capR, capH: capR * lerp(0.42, 0.72, rand()), bell: lerp(1.0, 2.3, rand()),
    stemR: Math.max(0.025, H * lerp(0.04, 0.058, rand())),
    bx: Math.cos(la) * lean, bz: Math.sin(la) * lean,
    tilt: new THREE.Quaternion().setFromAxisAngle(ax, (rand() - 0.5) * 0.22),
    ring: !tiny && H > 1.6 && rand() < 0.5,
    cap, flesh: new THREE.Color().setHSL(lerp(0.07, 0.11, rand()), lerp(0.15, 0.3, rand()), lerp(0.8, 0.88, rand())),
    yaw: rand() * Math.PI * 2, tiny,
  };
}

type V2 = [number, number];
const lathe = (pts: V2[], seg: number) => new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), seg);

/** Color y parte (0 pie, 1 láminas, 2 sombrero) en todos los vértices: mergeGeometries exige los mismos atributos. */
function paint(g: THREE.BufferGeometry, c: THREE.Color, part: number) {
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3), pa = new Float32Array(n).fill(part);
  for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aPart', new THREE.BufferAttribute(pa, 1));
  return g;
}

/** Curva el pie: la punta se desplaza (bx, bz) y el resto en proporción cuadrática a la altura. */
function bend(g: THREE.BufferGeometry, s: Shroom, top: number) {
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const k = Math.max(0, p.getY(i)) / top;
    p.setXYZ(i, p.getX(i) + s.bx * k * k, p.getY(i), p.getZ(i) + s.bz * k * k);
  }
}

interface Parts { cap: THREE.BufferGeometry[]; flesh: THREE.BufferGeometry[]; col: THREE.BufferGeometry[] }

function buildShroom(s: Shroom, out: Parts) {
  const { H, capR, capH, stemR } = s;
  const segCap = s.tiny ? 10 : H < 2 ? 18 : 28, segStem = s.tiny ? 6 : H < 2 ? 8 : 12;
  // el sombrero: el borde queda a 0,3·capH por debajo del punto de unión con el pie, la cima a 0,7·capH por encima
  const stemTop = H - capH * 0.7;
  const rimY = -capH * 0.3, topY = capH * 0.7;

  // pie (perfil de abajo arriba: normales hacia fuera), afinándose hacia arriba y metido en el sombrero
  const stemProf: V2[] = [[0, -0.05], [stemR * 1.7, -0.05], [stemR * 1.65, 0.0], [stemR * 1.45, stemTop * 0.04],
    [stemR * 1.12, stemTop * 0.11], [stemR, stemTop * 0.24], [stemR * 0.92, stemTop * 0.5], [stemR * 0.84, stemTop * 0.78],
    [stemR * 0.8, stemTop], [stemR * 0.78, stemTop + capH * 0.3], [0, stemTop + capH * 0.3]];
  const stem = paint(lathe(stemProf, segStem), s.flesh, 0);
  bend(stem, s, stemTop);
  const M = new THREE.Matrix4().makeTranslation(s.x, 0, s.z).multiply(new THREE.Matrix4().makeRotationY(s.yaw));
  stem.applyMatrix4(M);
  out.flesh.push(stem);

  // anillo (falda caída) a 3/4 del pie: cara de arriba de fuera adentro y cara de abajo de dentro afuera
  if (s.ring) {
    const y = stemTop * 0.74, r0 = stemR * 0.86, r1 = stemR * 2.5, d = H * 0.05;
    const ring = mergeGeometries([
      paint(lathe([[r1, y - d], [r1 * 0.8, y - d * 0.45], [r0 * 1.2, y - d * 0.05], [r0, y + 0.01]], segStem + 4), s.flesh, 0),
      paint(lathe([[r0, y - 0.02], [r1 * 0.75, y - d * 0.6], [r1 * 0.98, y - d - 0.02]], segStem + 4), s.flesh, 0),
    ])!;
    bend(ring, s, stemTop);
    ring.applyMatrix4(M);
    out.flesh.push(ring);
  }

  // sombrero: cara de arriba (del borde a la cima) y láminas (del pie al borde, mirando abajo)
  const n = s.tiny ? 6 : 12;
  const top: V2[] = [[capR * 0.94, rimY - capH * 0.05], [capR * 0.94, rimY - capH * 0.05]];   // arista viva en el borde
  for (let i = n; i >= 0; i--) {
    const t = (i / n) * (Math.PI / 2);
    top.push([capR * Math.sin(t), rimY + capH * (1 - (1 - Math.cos(t)) ** s.bell)]);
  }
  const gill: V2[] = [[stemR * 0.7, capH * 0.18], [stemR * 1.3, capH * 0.12], [capR * 0.45, capH * 0.02],
    [capR * 0.8, rimY + capH * 0.08], [capR * 0.94, rimY - capH * 0.05]];
  // el sombrero sigue la tangente del pie en la punta, más un giro propio
  const tip = new THREE.Vector3(s.bx, stemTop, s.bz);
  const tan = new THREE.Vector3(2 * s.bx / stemTop, 1, 2 * s.bz / stemTop).normalize();
  const C = M.clone().multiply(new THREE.Matrix4().compose(tip,
    new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), tan).multiply(s.tilt), new THREE.Vector3(1, 1, 1)));
  out.cap.push(paint(lathe(top, segCap), s.cap, 2).applyMatrix4(C));
  const gillCol = s.flesh.clone().lerp(new THREE.Color(0.85, 0.6, 0.55), 0.35);
  out.flesh.push(paint(lathe(gill, segCap), gillCol, 1).applyMatrix4(C));

  if (s.tiny) return;
  // colisión: pie y sombrero simplificados, sin vértices en el eje (triángulos degenerados)
  const cs = lathe(stemProf.filter(([r]) => r > 0.001).slice(1), 8);
  bend(cs, s, stemTop);
  out.col.push(cs.applyMatrix4(M));
  const coarseTop = top.filter(([r], i) => i >= 2 && i % 2 === 0 && r > 0.001);
  out.col.push(lathe([gill[1], gill[3], top[0], ...coarseTop], 10).applyMatrix4(C));
}

// ---------- Colocación ----------
export interface MushroomField { group: THREE.Group; colliders: THREE.BufferGeometry[]; list: Shroom[] }

export function placeMushrooms(): Shroom[] {
  const rand = mulberry32(10003);
  const list: Shroom[] = [];
  const free = (x: number, z: number, r: number) =>
    Math.hypot(x, z) < DOME_R - 14 - r &&
    Math.hypot(x - SPAWN.x, z - SPAWN.z) > 9 + r &&
    Math.hypot(x - DOOR_POS.x, z - DOOR_POS.z) > 8 + r &&
    !list.some((o) => !o.tiny && Math.hypot(o.x - x, o.z - z) < (o.capR + r) * 0.62);
  /** Altura típica: casi todos de 3 a 5 m; algunos de ~1 m y unos pocos de hasta 7,5 m. */
  const height = () => {
    const u = rand();
    return u < 0.14 ? lerp(0.7, 1.6, rand()) : u < 0.86 ? lerp(3, 5, rand()) : lerp(5, 7.5, rand() ** 1.3);
  };
  const add = (x: number, z: number, H: number) => {
    const s = randomShroom(rand, x, z, H);
    if (!free(x, z, s.capR)) return false;
    list.push(s);
    return true;
  };

  // junto a la puerta, como en la referencia: uno grande a cada lado
  const inward = new THREE.Vector3(-DOOR_POS.x, 0, -DOOR_POS.z).normalize();
  const side = new THREE.Vector3(-inward.z, 0, inward.x);
  for (const [lat, dep, H] of [[-9, 8, 6.4], [-14, 15, 2.6], [8.5, 9, 4.2], [12, 4.5, 1.1]]) {
    const p = DOOR_POS.clone().addScaledVector(side, lat).addScaledVector(inward, dep);
    list.push(randomShroom(rand, p.x, p.z, H));
  }

  // alrededor del punto inicial: un grupo delante (al este) y algunos a los lados, para que la primera vista no esté vacía
  for (const [dx, dz, H] of [[26, -2, 5.6], [31, -9, 3.4], [23, 7, 2.7], [34, 4, 4.3], [28, -5, 1.0], [21, -11, 0.9],
    [46, 15, 6.9], [50, 22, 3.6], [53, -24, 4.9], [14, -14, 4.6], [-12, -9, 5.2], [-6, 16, 3.8], [12, 18, 1.2]]) {
    add(SPAWN.x + dx, SPAWN.z + dz, H);
  }
  stamp(0, SPAWN.x + 29, SPAWN.z, 14, 0.9, 0.8);

  // grupos: uno o dos hongos madre y varios más pequeños alrededor
  for (let c = 0; c < 240; c++) {
    const r = DOME_R * Math.sqrt(rand()) * 0.97, a = rand() * Math.PI * 2;
    const cx = Math.cos(a) * r, cz = Math.sin(a) * r;
    const spread = lerp(3, 13, rand());
    const count = 2 + Math.floor(rand() * 8);
    add(cx, cz, Math.max(height(), lerp(4, 6.8, rand())));
    for (let k = 0, t = 0; k < count && t < 40; t++) {
      const d = spread * Math.sqrt(rand()), b = rand() * Math.PI * 2;
      if (add(cx + Math.cos(b) * d, cz + Math.sin(b) * d, height())) k++;
    }
    stamp(0, cx, cz, spread * 1.8 + 5, 0.9, 0.8);   // micelio bajo el grupo
  }

  // corros de brujas: anillos perfectos de hongos pequeños (el micelio crece en círculo)
  for (let c = 0; c < 9; c++) {
    const r = DOME_R * Math.sqrt(rand()) * 0.9, a = rand() * Math.PI * 2;
    const cx = Math.cos(a) * r, cz = Math.sin(a) * r, R = lerp(4.5, 11, rand());
    const n = Math.round(R * lerp(2.2, 3.2, rand()));
    for (let k = 0; k < n; k++) {
      const b = (k / n) * Math.PI * 2 + (rand() - 0.5) * 0.12, d = R + (rand() - 0.5) * 0.6;
      add(cx + Math.cos(b) * d, cz + Math.sin(b) * d, lerp(0.6, 1.5, rand()));
    }
    for (let k = 0; k < 40; k++) stamp(0, cx + Math.cos((k / 40) * Math.PI * 2) * R, cz + Math.sin((k / 40) * Math.PI * 2) * R, 2.2, 0.8, 1);
  }

  // sueltos por todo el tablero (con un camino de unos pocos alrededor del punto inicial)
  for (let k = 0; k < 420; k++) {
    const r = DOME_R * Math.sqrt(rand()), a = rand() * Math.PI * 2;
    add(Math.cos(a) * r, Math.sin(a) * r, height());
  }

  // brotes: entre 0 y 5 hongos diminutos alrededor de cada hongo grande
  const big = list.filter((s) => s.H > 2);
  for (const s of big) {
    const n = rand() < 0.5 ? 0 : Math.floor(rand() * 4);
    for (let k = 0; k < n; k++) {
      const d = s.stemR * 2.5 + rand() * s.capR * 1.3, b = rand() * Math.PI * 2;
      list.push(randomShroom(rand, s.x + Math.cos(b) * d, s.z + Math.sin(b) * d, lerp(0.12, 0.5, rand() ** 1.4), true));
    }
  }

  // sombra de contacto bajo cada sombrero y micelio alrededor de cada pie
  for (const s of list) {
    if (s.tiny) continue;
    stamp(1, s.x + s.bx * 0.5, s.z + s.bz * 0.5, s.capR * 1.25, Math.min(0.75, 0.25 + s.H * 0.08), 1.6);
    stamp(1, s.x, s.z, s.stemR * 5, 0.8, 1.2);
    stamp(0, s.x, s.z, s.capR * 1.8 + 1, 0.7, 0.8);
  }
  return list;
}

// ---------- Materiales ----------
/** Sombrero: rojo húmedo, más oscuro hacia el borde, con vetas radiales y moteado. */
const CAP_MAP = /* glsl */ `
  #include <color_fragment>
  float mot = vnoise(vWPos.xz * 3.1 + vWPos.y * 2.3) * 0.6 + vnoise(vWPos.xz * 11.0 - vWPos.y * 7.0) * 0.4;
  float streak = vnoise(vec2(vLUv.x * 110.0, vLUv.y * 3.0));
  diffuseColor.rgb *= mix(0.55, 1.08, smoothstep(0.0, 0.55, vLUv.y));   // el borde (v = 0) más oscuro
  diffuseColor.rgb *= 0.86 + 0.22 * mot + 0.1 * (streak - 0.5);
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.15, 1.25, 1.1) + 0.02, smoothstep(0.85, 1.0, vLUv.y) * 0.4);
`;
/** Carne (pie, anillo y láminas): blanca crema con fibras; las láminas con rayas radiales y un brillo muy tenue. */
const FLESH_MAP = /* glsl */ `
  #include <color_fragment>
  float fib = vnoise(vec2(vLUv.x * 70.0, vLUv.y * 2.0)) * 0.5 + vnoise(vec2(vLUv.x * 160.0, vLUv.y * 9.0)) * 0.5;
  float gills = step(0.5, vPart) * step(vPart, 1.5);
  float lam = abs(fract(vLUv.x * 150.0) - 0.5) * 2.0;
  float lamAA = fwidth(vLUv.x * 150.0) * 2.0;
  diffuseColor.rgb *= mix(0.88 + 0.16 * fib, 0.62 + 0.38 * smoothstep(0.2, 0.2 + lamAA + 0.3, lam), gills);
  diffuseColor.rgb *= 0.92 + 0.12 * vnoise(vWPos.xz * 5.0 + vWPos.y * 3.0);
`;
const GILL_GLOW = /* glsl */ `
  #include <emissivemap_fragment>
  totalEmissiveRadiance += vec3(1.0, 0.42, 0.32) * 0.018 * gills * smoothstep(0.1, 0.9, vLUv.y);
`;

function shroomMaterial(key: 'cap' | 'flesh'): THREE.MeshStandardMaterial {
  const cap = key === 'cap';
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: cap ? 0.36 : 0.72, metalness: 0 });
  return patch(mat, 'shroom-' + key, (s) => {
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aPart;\nvarying float vPart;\nvarying vec2 vLUv;\nvarying vec3 vWPos;')
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vLUv = uv;
vPart = aPart;`);
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying float vPart;\nvarying vec2 vLUv;\nvarying vec3 vWPos;\n${NOISE_GLSL}`)
      .replace('#include <color_fragment>', cap ? CAP_MAP : FLESH_MAP);
    if (!cap) s.fragmentShader = s.fragmentShader.replace('#include <emissivemap_fragment>', GILL_GLOW);
  });
}

export function buildMushrooms(list: Shroom[]): MushroomField {
  const chunks = new Map<string, Parts>();
  const colliders: THREE.BufferGeometry[] = [];
  for (const s of list) {
    const k = `${Math.floor(s.x / CHUNK)},${Math.floor(s.z / CHUNK)}`;
    let c = chunks.get(k);
    if (!c) chunks.set(k, (c = { cap: [], flesh: [], col: [] }));
    buildShroom(s, c);
  }
  const group = new THREE.Group();
  const mats = { cap: shroomMaterial('cap'), flesh: shroomMaterial('flesh') };
  for (const c of chunks.values()) {
    for (const key of ['cap', 'flesh'] as const) {
      const g = mergeGeometries(c[key], false);
      c[key].forEach((x) => x.dispose());
      if (!g) continue;
      g.computeBoundingSphere();
      const m = new THREE.Mesh(g, mats[key]);
      m.castShadow = true; m.receiveShadow = true;
      group.add(m);
    }
    for (const g of c.col) {
      const p = new THREE.BufferGeometry();
      p.setAttribute('position', g.attributes.position);
      p.setIndex(g.index);
      colliders.push(p);
    }
  }
  return { group, colliders, list };
}
