import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { loadTextures } from './materials';
import { buildBoard, FieldReflection, REFLECT_LAYER } from './board';
import { placeMushrooms, buildMushrooms } from './mushrooms';
import { buildDoor } from './door';
import { createSpores } from './spores';
import { SkySystem } from './sky';
import { Player, MOVE_KEYS } from './player';
import { SPAWN, atDoor } from './world';
import { Q } from './config';

// Parámetros opcionales en la URL (para pruebas): ?x=&z=&y=&yaw=&pitch= posición, ?shot=1 sin pausa, ?q=, ?fps=
const params = new URLSearchParams(location.search);
const num = (k: string, d: number) => (params.has(k) ? Number(params.get(k)) : d);

const hud = document.getElementById('hud')!;
const hudText = document.getElementById('hudText')!;
const fpsEl = document.getElementById('fps')!;
const autoEl = document.getElementById('auto')!;
const fadeEl = document.getElementById('fade')!;
const setStatus = (s: string) => { hudText.innerHTML = s; };
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

// ---------- Renderizador ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
let pixelRatio = Math.min(devicePixelRatio, Q.pixelRatio);
renderer.setPixelRatio(pixelRatio);
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x000000, 0.003);
const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 2000);

async function init() {
  setStatus('Cargando texturas… 0%');
  const manager = new THREE.LoadingManager();
  manager.onProgress = (_u, loaded, total) => setStatus(`Cargando texturas… ${Math.round((loaded / total) * 100)}%`);
  const T = await loadTextures(manager, renderer.capabilities.getMaxAnisotropy());

  setStatus('Haciendo crecer los hongos…');
  await nextFrame();
  const shrooms = buildMushrooms(placeMushrooms());   // también pintan la máscara del suelo (antes del tablero)
  scene.add(shrooms.group);

  const reflection = new FieldReflection(Q.reflection);
  scene.add(buildBoard(T, reflection));
  const door = buildDoor();
  scene.add(door.group, door.glow);
  const spores = createSpores();
  scene.add(spores.points);
  spores.uniforms.uScale.value = pixelRatio;

  const colGeo = shrooms.colliders.length ? mergeGeometries(shrooms.colliders, false) : null;
  const player = new Player(colGeo ? new MeshBVH(colGeo) : null);
  const respawn = () => {
    player.pos.set(SPAWN.x, 0, SPAWN.z);
    player.vel.set(0, 0, 0);
    player.yaw = SPAWN.yaw;
    player.pitch = 0.02;
  };
  respawn();
  player.pos.set(num('x', SPAWN.x), num('y', 0), num('z', SPAWN.z));
  player.yaw = num('yaw', SPAWN.yaw);
  player.pitch = num('pitch', 0.02);

  const sky = new SkySystem(renderer, scene);

  // lo que se refleja en el tablero
  for (const o of [shrooms.group, door.group, door.glow, sky.dome, sky.stars, sky.light, sky.hemi]) {
    o.traverse((c) => c.layers.enable(REFLECT_LAYER));
  }
  const shot = params.get('shot') === '1';
  Object.assign(window, { __game: { THREE, scene, renderer, camera, player, sky, shrooms, door, spores, reflection } });

  // ---------- Controles ----------
  const keys = new Set<string>();
  let locked = false;
  let needsFrame = true;   // dibujar un fotograma aunque el juego esté en pausa (al cargar, al redimensionar)
  const setAuto = (on: boolean) => { player.auto = on; autoEl.classList.toggle('on', on); };
  addEventListener('keydown', (e) => {
    keys.add(e.code);
    if (e.code === 'Space') e.preventDefault();
    if (e.code === 'KeyF' && !e.repeat && fade === 0) setAuto(!player.auto);
    else if (MOVE_KEYS.includes(e.code)) setAuto(false);   // WASD o flechas: se para y sigue con el teclado
  });
  addEventListener('keyup', (e) => keys.delete(e.code));
  addEventListener('blur', () => keys.clear());
  hud.addEventListener('click', () => renderer.domElement.requestPointerLock());
  document.addEventListener('pointerlockchange', () => {
    locked = document.pointerLockElement === renderer.domElement;
    hud.classList.toggle('hidden', locked);
    if (!locked) { keys.clear(); fpsEl.textContent = ''; }
  });
  addEventListener('mousemove', (e) => {
    if (locked) player.look(e.movementX, e.movementY);
  });
  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    needsFrame = true;
  });

  setStatus('<b style="font-size:24px;letter-spacing:.08em">LEVEL 10.003</b><br>Click para jugar<br><small>WASD mover · Shift correr · Espacio saltar · F caminar solo (WASD para parar) · Esc soltar el ratón</small>');
  if (shot) hud.classList.add('hidden');

  // ---------- La puerta: fundido a blanco y vuelta al punto inicial ----------
  // fade: 0 nada · 1 fundiendo a blanco · 2 volviendo del blanco
  let fade = 0, fadeT = 0;
  const updateFade = (dt: number) => {
    if (fade === 0 && atDoor(player.pos)) {
      fade = 1; fadeT = 0;
      setAuto(false);
      fadeEl.style.transition = 'opacity 1.4s ease-in';
      fadeEl.style.opacity = '1';
    } else if (fade === 1 && (fadeT += dt) > 1.6) {
      respawn();
      fade = 2; fadeT = 0;
      fadeEl.style.transition = 'opacity 2.6s ease-out';
      fadeEl.style.opacity = '0';
    } else if (fade === 2 && (fadeT += dt) > 1.0) fade = 0;
  };

  // ---------- Bucle ----------
  // · Con el menú abierto no se dibuja nada.
  // · Límite de FPS (Q.fpsCap): en pantallas de 120 Hz dibujaría el doble sin necesidad.
  // · Resolución dinámica: si durante 6 s seguidos no se llega al ritmo de la pantalla, baja un escalón
  //   (nunca por debajo de Q.minPixelRatio). Se ignoran el arranque y los tirones sueltos (compilar shaders).
  const FRAME = 1 / Q.fpsCap;
  let last = -1, lastRender = 0, budget = 0, elapsed = 0;
  let refresh = 1 / 60;                     // intervalo medio entre fotogramas de la pantalla
  let fpsT = 0, fpsN = 0, dynT = 0, dynN = 0, slow = 0, played = 0, hitch = false;
  renderer.setAnimationLoop((now: number) => {
    const t = now / 1000;
    if (last < 0) last = lastRender = t;
    const raw = Math.min(t - last, 0.1);
    last = t;
    refresh += (raw - refresh) * 0.05;
    const paused = !locked && !shot;
    if (paused && !needsFrame) return;
    budget += raw;
    if (!needsFrame && budget < FRAME * 0.92) return;
    budget = Math.min(Math.max(budget - FRAME, 0), FRAME);
    const realDt = t - lastRender;
    lastRender = t;
    needsFrame = false;
    const dt = paused ? 0 : Math.min(realDt, 0.05);

    elapsed += dt;
    if (!paused && fade !== 1) player.update(dt, keys);
    updateFade(dt);
    player.applyCamera(camera);
    sky.update(dt, camera, player.pos);
    door.update(camera);
    spores.uniforms.uTime.value = elapsed;
    spores.uniforms.uCenter.value.copy(camera.position);
    reflection.update(renderer, scene, camera);
    renderer.render(scene, camera);
    if (paused) return;

    fpsT += realDt; fpsN++;
    if (fpsT > 0.5) {
      fpsEl.textContent = `${Math.round(fpsN / fpsT)} fps`;
      fpsT = 0; fpsN = 0;
      (window as unknown as { __ready: boolean }).__ready = true;
    }
    dynT += realDt; dynN++; played += realDt;
    if (realDt > 0.1) hitch = true;
    if (dynT > 2) {
      if (played > 6 && !hitch) {
        const target = Math.min(Q.fpsCap, 1 / refresh);
        slow = dynN / dynT < target * 0.85 ? slow + 1 : 0;
        if (slow >= 3 && pixelRatio > Q.minPixelRatio + 1e-3) {
          pixelRatio = Math.max(Q.minPixelRatio, pixelRatio - 0.125);
          renderer.setPixelRatio(pixelRatio);
          sky.setPixelRatio(pixelRatio);
          spores.uniforms.uScale.value = pixelRatio;
          slow = 0;
        }
      }
      dynT = 0; dynN = 0; hitch = false;
    }
  });
}

init().catch((err) => {
  console.error(err);
  setStatus(`Error al cargar: ${err?.message ?? err}`);
});
