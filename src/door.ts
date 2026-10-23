import * as THREE from 'three';
import { patch } from './materials';
import { DOOR, DOOR_POS } from './world';

// ---------- La puerta de luz ----------
// Un hueco blanco en la pared de la cúpula, lejos del punto inicial. Desde lejos solo se ve un resplandor;
// de cerca ilumina el tablero y proyecta en el suelo la forma de la puerta. Cruzarla (main.ts) devuelve al inicio.

const GLOW_FRAG = /* glsl */ `
uniform float uK;
varying vec2 vUv;
void main() {
  vec2 p = (vUv - 0.5) * 2.0;
  float d = length(p * vec2(1.0, 0.62));
  float g = (exp(-d * 5.0) * 0.9 + exp(-d * 14.0) * 1.4) * (1.0 - smoothstep(0.45, 1.0, length(p)));   // nada en los bordes del cuadrado
  gl_FragColor = vec4(vec3(1.0, 0.97, 0.92) * g * uK, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/** La luz que sale por la puerta y se tiende sobre el tablero, ensanchándose y apagándose. */
const SPILL_FRAG = /* glsl */ `
varying vec2 vUv;
void main() {
  float along = vUv.y;                                  // 0 en la puerta, 1 al final
  float hw = mix(0.5, 1.0, along) * 0.5;              // se abre como un trapecio
  float across = abs(vUv.x - 0.5);
  float edge = 1.0 - smoothstep(hw * 0.55, hw, across);
  float a = edge * pow(1.0 - along, 1.6) * 0.5;
  gl_FragColor = vec4(vec3(1.0, 0.96, 0.9) * a, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export function buildDoor() {
  const group = new THREE.Group();
  const inward = new THREE.Vector3(-DOOR_POS.x, 0, -DOOR_POS.z).normalize();
  group.position.copy(DOOR_POS).addScaledVector(inward, 0.02);
  group.rotation.y = Math.atan2(inward.x, inward.z);   // +z local = hacia dentro de la cúpula
  const { w, h } = DOOR;

  // marco de mármol negro
  const frame = patch(new THREE.MeshStandardMaterial({ color: 0x0c0c0e, roughness: 0.35, metalness: 0 }), 'doorframe');
  const t = 0.32, d = 0.45;
  for (const [bw, bh, x, y] of [[t, h + t, -(w + t) / 2, (h + t) / 2], [t, h + t, (w + t) / 2, (h + t) / 2], [w + 2 * t, t, 0, h + t / 2]]) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, d), frame);
    m.position.set(x, y, d / 2 - 0.2);
    m.castShadow = true; m.receiveShadow = true;
    group.add(m);
  }

  // el hueco: blanco puro (no lo afecta la niebla: se ve desde lejos como un punto de luz)
  const opening = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 5.9, 5.6), fog: false }));
  opening.position.set(0, h / 2, -0.05);
  group.add(opening);

  // resplandor: un cuadrado de cara a la cámara, adelantado hacia ella para que la pared no lo corte de lado
  const glowU = { uK: { value: 1 }, uSize: { value: 26 } };
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({
    uniforms: glowU,
    vertexShader: /* glsl */ `
      uniform float uSize;
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec4 c = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        float len = length(c.xyz);
        c.xyz *= max(len - min(10.0, len * 0.5), 0.5) / len;
        c.xy += position.xy * uSize;
        gl_Position = projectionMatrix * c;
      }`,
    fragmentShader: GLOW_FRAG, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
  }));
  glow.frustumCulled = false;
  glow.renderOrder = 20;

  // la luz derramada en el suelo
  const L = 22;
  const spill = new THREE.Mesh(new THREE.PlaneGeometry(w * 2.2, L), new THREE.ShaderMaterial({
    vertexShader: 'varying vec2 vUv; void main() { vUv = vec2(uv.x, 1.0 - uv.y); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: SPILL_FRAG, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
  }));
  spill.rotation.x = -Math.PI / 2;
  spill.position.set(0, 0.02, L / 2);
  spill.renderOrder = 19;
  group.add(spill);

  // y la luz de verdad: ilumina el tablero y los hongos que la flanquean
  const light = new THREE.PointLight(0xfff4e6, 220, 80, 1.7);
  light.position.set(0, h * 0.55, 2.2);
  group.add(light);

  group.updateMatrixWorld(true);
  glow.position.set(0, h * 0.5, 0.6).applyMatrix4(group.matrixWorld);
  return {
    group, glow,
    /** De lejos el resplandor pierde fuerza pero no desaparece (es la única pista de dónde está la puerta). */
    update(camera: THREE.Camera) {
      const dist = camera.position.distanceTo(glow.position);
      glowU.uK.value = THREE.MathUtils.lerp(1, 0.18, THREE.MathUtils.smoothstep(dist, 20, 700));
      glowU.uSize.value = 26 * THREE.MathUtils.lerp(1, 2.2, THREE.MathUtils.smoothstep(dist, 40, 700));
    },
  };
}
