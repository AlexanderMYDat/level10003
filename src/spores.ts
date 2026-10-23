import * as THREE from 'three';
import { mulberry32 } from './noise';
import { Q } from './config';

// ---------- Esporas ----------
// Motas tenues que suben despacio alrededor del jugador. Misma técnica que el césped del Level 94:
// un bloque que se repite y sigue a la cámara, con las motas fijas en el mundo (no se deslizan).
const BOX = 48, HIGH = 16;

export function createSpores() {
  const rand = mulberry32(5150);
  const N = Q.spores;
  const seed = new Float32Array(N * 4);
  for (let i = 0; i < N; i++) seed.set([rand() * BOX, rand() * HIGH, rand() * BOX, rand()], i * 4);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));   // no se usa (todo sale de aSeed)
  g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
  const uniforms = { uTime: { value: 0 }, uCenter: { value: new THREE.Vector3() }, uScale: { value: 1 } };
  const points = new THREE.Points(g, new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `
      attribute vec4 aSeed;
      uniform float uTime, uScale;
      uniform vec3 uCenter;
      varying vec3 vCol;
      void main() {
        float s = aSeed.w;
        vec3 p = aSeed.xyz;
        p.x += sin(uTime * (0.07 + 0.05 * s) + s * 40.0) * 1.8;
        p.z += cos(uTime * (0.06 + 0.04 * s) + s * 70.0) * 1.8;
        p.y = mod(p.y + uTime * (0.05 + 0.12 * s), ${HIGH.toFixed(1)});
        p.xz += ${BOX.toFixed(1)} * floor((uCenter.xz - p.xz) / ${BOX.toFixed(1)} + 0.5);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float d = -mv.z;
        float fade = smoothstep(0.4, 2.0, d) * (1.0 - smoothstep(14.0, 23.0, length(p.xz - uCenter.xz)));
        float tw = 0.55 + 0.45 * sin(uTime * (1.0 + 2.0 * s) + s * 90.0);
        vCol = mix(vec3(1.0, 0.62, 0.42), vec3(0.85, 0.95, 0.8), step(0.7, s)) * 0.32 * fade * tw;
        gl_PointSize = clamp((1.5 + 2.0 * s) * 12.0 / d, 1.5, 6.0) * uScale;
        if (fade <= 0.0) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vCol;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        gl_FragColor = vec4(vCol * smoothstep(0.5, 0.0, d), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
  }));
  points.frustumCulled = false;
  points.renderOrder = 15;
  return { points, uniforms };
}
