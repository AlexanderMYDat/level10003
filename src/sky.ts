import * as THREE from 'three';
import { fogShared, NOISE_GLSL } from './materials';
import { mulberry32 } from './noise';
import { DOME_R, STAR_POS, WORLD_GLSL } from './world';
import { Q } from './config';

// ---------- La cúpula ----------
// Una semiesfera real de radio DOME_R (no sigue a la cámara): se puede caminar hasta la pared.
// Casi negra, con grano, ojos grises muy tenues que parpadean y miran al jugador, y la estrella superior.
const DOME_FRAG = /* glsl */ `
uniform vec3 uStarPos;
uniform float uTime, uEyeI, uStarI;
varying vec3 vWPos;
${WORLD_GLSL}
${NOISE_GLSL}
void main() {
  vec3 n = normalize(vWPos);
  vec3 V = normalize(vWPos - cameraPosition);
  // fondo: negro azulado con grano muy suave y un poco más claro al pie de la pared
  float g = vnoise(n.xz * 60.0 + n.y * 17.0) * 0.5 + vnoise(n.xy * 160.0 + 3.0) * 0.5;
  vec3 col = vec3(0.0030, 0.0030, 0.0048) * (0.65 + 0.7 * g) * (1.0 + 1.2 * (1.0 - smoothstep(0.0, 0.08, n.y)));

  // ---- ojos: una rejilla en acimut/elevación (filas de 4°), con huecos ----
  float el = asin(clamp(n.y, -1.0, 1.0));
  float az = atan(n.z, n.x);
  const float BAND = 0.0698;            // 4° en radianes
  const float EL0 = 0.03;
  float row = floor((el - EL0) / BAND);
  if (row >= 0.0 && el < 1.36) {
    float elR = EL0 + (row + 0.5) * BAND;
    float cnt = max(3.0, floor(6.2832 * cos(elR) / BAND));
    float cw = 6.2832 / cnt;
    float ci = floor((az + 3.14159) / cw);
    vec2 id = vec2(row, ci);
    if (hash12(id + 31.0) < 0.42) {
      float azC = -3.14159 + (ci + 0.5) * cw + (hash12(id + 7.0) - 0.5) * cw * 0.25;
      float elC = elR + (hash12(id + 13.0) - 0.5) * BAND * 0.25;
      float size = BAND * (0.2 + 0.18 * hash12(id + 3.0));      // media anchura del ojo (rad)
      float dAz = az - azC;
      dAz -= 6.2832 * floor((dAz + 3.14159) / 6.2832);
      float rot = (hash12(id + 5.0) - 0.5) * 0.6;
      mat2 Rm = mat2(cos(rot), sin(rot), -sin(rot), cos(rot));
      vec2 p = Rm * (vec2(dAz * cos(el), el - elC) / size);
      if (abs(p.x) < 1.1 && abs(p.y) < 0.7) {
        // parpadeo: cada 6–16 s, ~0,25 s
        float period = 6.0 + 10.0 * hash12(id + 11.0);
        float tt = mod(uTime + hash12(id + 17.0) * period, period);
        float open = clamp(abs(tt - 0.13) / 0.13, 0.0, 1.0);
        float lid = 0.44 * max(open, 0.03) * (1.0 - p.x * p.x);
        float f = abs(p.y) - lid;
        float aa = fwidth(p.y) * 1.2 + 1e-4;
        float edgeX = 1.0 - smoothstep(0.98, 1.0, abs(p.x));
        float inside = (1.0 - smoothstep(-aa, aa, f)) * edgeX;
        float outline = (1.0 - smoothstep(0.035, 0.035 + aa * 1.5, abs(f))) * (1.0 - smoothstep(1.0, 1.06, abs(p.x)));
        // la pupila mira hacia el jugador
        vec3 C = vec3(cos(elC) * cos(azC), sin(elC), cos(elC) * sin(azC)) * DOME_R;
        vec3 toCam = normalize(cameraPosition - C);
        vec3 east = vec3(-sin(azC), 0.0, cos(azC));
        vec3 north = vec3(-sin(elC) * cos(azC), cos(elC), -sin(elC) * sin(azC));
        vec2 pc = (Rm * vec2(dot(toCam, east), dot(toCam, north))) * vec2(0.5, 0.18);
        float dI = length(p - pc);
        float iris = 1.0 - smoothstep(0.29, 0.29 + aa, dI);
        float pupil = 1.0 - smoothstep(0.12, 0.12 + aa, dI);
        float ring = 1.0 - smoothstep(0.0, aa * 2.0, abs(dI - 0.29));
        vec3 eye = mix(vec3(0.5, 0.5, 0.53), vec3(0.24, 0.23, 0.26), iris);
        eye = mix(eye, vec3(0.01), pupil);
        eye += 0.35 * ring * iris;
        eye += 0.9 * (1.0 - smoothstep(0.035, 0.035 + aa, length(p - pc - vec2(-0.07, 0.06))));   // brillo
        float b = uEyeI * (0.45 + 0.55 * hash12(id + 19.0));
        col = mix(col, eye * b, inside);
        col = max(col, vec3(0.75) * b * outline);
      }
    }
  }

  // ---- la estrella superior: núcleo, halo y cuatro rayos ----
  vec3 toS = normalize(uStarPos - cameraPosition);
  float c = max(dot(V, toS), 0.0);
  vec3 sCol = vec3(0.93, 0.96, 1.0);
  col += sCol * uStarI * (pow(c, 3000.0) * 2.5 + pow(c, 300.0) * 0.25 + pow(c, 30.0) * 0.02 + pow(c, 6.0) * 0.004);
  vec3 sn = normalize(uStarPos), e1 = normalize(cross(vec3(0.0, 1.0, 0.0), sn)), e2 = cross(sn, e1);
  vec3 w = vWPos - uStarPos;
  float a = dot(w, e1), b = dot(w, e2);
  float core = 1.0 - smoothstep(3.0, 4.6, length(w));
  float rays = exp(-abs(b) * 1.1 - abs(a) * 0.035) + exp(-abs(a) * 1.1 - abs(b) * 0.035);
  // en el pase del reflejo (cámara bajo el tablero) el núcleo, más flojo: los mipmaps del reflejo
  // lo extenderían por todo el suelo como un velo gris
  float coreI = cameraPosition.y < 0.0 ? 2.5 : 40.0;
  col += sCol * uStarI * (core * coreI + rays * 0.6);

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** El mapa de entorno: negro con el brillo de la estrella (solo para reflejos y la luz ambiente de los materiales). */
const ENV_FRAG = /* glsl */ `
uniform vec3 uStarDir;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float c = max(dot(d, uStarDir), 0.0);
  vec3 col = vec3(0.006, 0.006, 0.01) + vec3(0.9, 0.95, 1.0) * (pow(c, 400.0) * 6.0 + pow(c, 20.0) * 0.08 + pow(c, 3.0) * 0.015);
  gl_FragColor = vec4(col, 1.0);
}
`;

export class SkySystem {
  readonly dome: THREE.Mesh;
  readonly stars: THREE.Points;
  readonly light = new THREE.DirectionalLight(0xeef2ff, 3);
  readonly hemi = new THREE.HemisphereLight(0x2a3050, 0x060607, 0.85);
  /** Dirección hacia la estrella desde el jugador (la luz cambia de ángulo según dónde estés). */
  readonly starDir = new THREE.Vector3();

  private domeU: Record<string, THREE.IUniform>;
  private starU: Record<string, THREE.IUniform>;
  private shadowCenter = new THREE.Vector3(1e9, 0, 0);
  private shadowDir = new THREE.Vector3();
  private time = 0;

  constructor(private renderer: THREE.WebGLRenderer, private scene: THREE.Scene) {
    // cúpula
    this.domeU = {
      uStarPos: { value: STAR_POS.clone() }, uTime: { value: 0 }, uEyeI: { value: 0.04 }, uStarI: { value: 1 },
    };
    this.dome = new THREE.Mesh(
      new THREE.SphereGeometry(DOME_R, 160, 60, 0, Math.PI * 2, 0, Math.PI / 2),
      new THREE.ShaderMaterial({
        uniforms: this.domeU,
        vertexShader: /* glsl */ `
          varying vec3 vWPos;
          void main() {
            vWPos = (modelMatrix * vec4(position, 1.0)).xyz;
            gl_Position = projectionMatrix * viewMatrix * vec4(vWPos, 1.0);
          }`,
        fragmentShader: DOME_FRAG,
        side: THREE.BackSide,
      }),
    );
    this.dome.frustumCulled = false;

    // estrellas: puntos tenues pegados a la cúpula, de tamaño fijo en pantalla
    const rand = mulberry32(31337);
    const N = 5200;
    const p = new Float32Array(N * 3), size = new Float32Array(N), phase = new Float32Array(N), c = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const y = 0.015 + 0.985 * Math.sqrt(rand()), th = rand() * Math.PI * 2, r = Math.sqrt(1 - y * y);
      p.set([Math.cos(th) * r * (DOME_R - 1.5), y * (DOME_R - 1.5), Math.sin(th) * r * (DOME_R - 1.5)], i * 3);
      size[i] = 1.0 + Math.pow(rand(), 7) * 3.0;
      phase[i] = rand() * 100;
      const t = rand();
      c.set(t < 0.12 ? [1.0, 0.86, 0.72] : t < 0.3 ? [0.75, 0.85, 1.0] : [1, 1, 1], i * 3);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(p, 3));
    sg.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    sg.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    sg.setAttribute('aColor', new THREE.BufferAttribute(c, 3));
    this.starU = { uTime: { value: 0 }, uScale: { value: renderer.getPixelRatio() } };
    this.stars = new THREE.Points(sg, new THREE.ShaderMaterial({
      uniforms: this.starU,
      vertexShader: /* glsl */ `
        attribute float aSize; attribute float aPhase; attribute vec3 aColor;
        uniform float uTime, uScale;
        varying vec3 vCol;
        void main() {
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          float tw = 0.65 + 0.35 * sin(uTime * (0.8 + fract(aPhase) * 2.5) + aPhase);
          vCol = aColor * tw * (0.25 + 0.75 * aSize / 4.0) * 0.55;
          gl_PointSize = aSize * uScale;
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vCol;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          gl_FragColor = vec4(vCol * smoothstep(0.5, 0.05, d), 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
    }));
    this.stars.frustumCulled = false;
    this.stars.renderOrder = 10;

    scene.add(this.dome, this.stars, this.light, this.light.target, this.hemi);

    // sombras: un mapa que sigue al jugador. Solo se vuelve a dibujar cuando hace falta (ver update)
    const L = this.light;
    L.castShadow = true;
    L.shadow.mapSize.set(Q.shadowMap, Q.shadowMap);
    renderer.shadowMap.autoUpdate = false;
    const S = Q.shadowRange;
    Object.assign(L.shadow.camera, { left: -S, right: S, top: S, bottom: -S, near: 1, far: 900 });
    L.shadow.bias = -0.0002;
    L.shadow.normalBias = 0.04;

    // niebla: casi negra; hacia la estrella, un velo gris azulado
    const fog = scene.fog as THREE.FogExp2;
    fog.color.setRGB(0.004, 0.004, 0.007);
    fog.density = 0.011;
    fogShared.fogSunColor.value.setRGB(0.05, 0.055, 0.075);

    // mapa de entorno: fijo (aquí no hay ciclo de día), se calcula una sola vez
    const envScene = new THREE.Scene();
    envScene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 64, 32), new THREE.ShaderMaterial({
      uniforms: { uStarDir: { value: STAR_POS.clone().normalize() } },
      vertexShader: 'varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: ENV_FRAG, side: THREE.BackSide,
    })));
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(envScene, 0).texture;
    scene.environmentIntensity = 1;
    pmrem.dispose();
  }

  /** Tamaño de las estrellas cuando cambia la resolución dinámica. */
  setPixelRatio(pr: number) { this.starU.uScale.value = pr; }

  update(dt: number, camera: THREE.Camera, target: THREE.Vector3) {
    this.time += dt;
    // la estrella "respira": su brillo oscila un 5 % muy despacio
    const breath = 1 + 0.05 * Math.sin(this.time * 0.35) + 0.02 * Math.sin(this.time * 1.7);
    this.light.intensity = 2.6 * breath;
    this.domeU.uStarI.value = breath;
    this.domeU.uTime.value = this.time;
    this.starU.uTime.value = this.time;

    // la luz viene de la estrella vista desde el jugador (la cúpula no está en el infinito)
    const lightDir = this.starDir.copy(STAR_POS).sub(target).normalize();
    fogShared.fogSunDir.value.copy(STAR_POS).sub(camera.position).normalize();

    // Sombra centrada en el jugador, ajustada a la rejilla del mapa para que no tiemble.
    // Todo está quieto, así que el mapa solo se redibuja si el jugador se ha alejado del centro.
    const L = this.light;
    if (target.distanceToSquared(this.shadowCenter) > 16 || lightDir.dot(this.shadowDir) < 0.99999) {
      const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(lightDir, new THREE.Vector3(), new THREE.Vector3(0, 1, 0)));
      const texel = (L.shadow.camera.right * 2) / L.shadow.mapSize.x;
      const snapped = target.clone().applyQuaternion(q.clone().invert());
      snapped.x = Math.round(snapped.x / texel) * texel;
      snapped.y = Math.round(snapped.y / texel) * texel;
      snapped.applyQuaternion(q);
      L.target.position.copy(snapped);
      L.position.copy(snapped).addScaledVector(lightDir, 450);
      this.shadowCenter.copy(target);
      this.shadowDir.copy(lightDir);
      this.renderer.shadowMap.needsUpdate = true;
    }
  }
}
