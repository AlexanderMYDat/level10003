import * as THREE from 'three';

// ---------- Geometría del nivel 10.003 (todo en metros; y = 0 es el tablero; z positiva = norte) ----------
// El mundo es un tablero de ajedrez plano encerrado en una cúpula negra (una semiesfera de radio DOME_R).
// No hay topes invisibles: el límite es la propia pared de la cúpula.

export const DOME_R = 600;
/** Lado de una casilla del tablero. */
export const FIELD_SQ = 2;
/** El jugador (radio 0,35) se queda a esta distancia del centro como mucho: pegado a la pared. */
export const WALK_R = DOME_R - 0.6;

const deg = THREE.MathUtils.degToRad;
/** Punto de la cúpula: acimut desde +x hacia +z y elevación sobre el horizonte. */
export const onDome = (az: number, el: number, r = DOME_R) =>
  new THREE.Vector3(Math.cos(el) * Math.cos(az) * r, Math.sin(el) * r, Math.cos(el) * Math.sin(az) * r);

/** La estrella superior: en la cúpula, al este, a 30° sobre el horizonte. Es la única luz del lugar. */
export const STAR_POS = onDome(deg(-20), deg(30), DOME_R - 2);

/** La puerta de luz: en la pared, al norte, lejos del punto inicial (~930 m). */
export const DOOR = { az: deg(100), w: 3.4, h: 6.6 };
export const DOOR_POS = onDome(DOOR.az, 0);

/** Punto inicial: al sur, mirando al este (la estrella queda a la derecha y la puerta a la espalda). */
export const SPAWN = { x: 0, z: -330, yaw: -1.35 };

/** Distancia (m, a lo largo de la pared) entre el acimut de (x, z) y el de la puerta. */
function doorOffset(x: number, z: number): number {
  let d = Math.atan2(z, x) - DOOR.az;
  d -= 2 * Math.PI * Math.floor((d + Math.PI) / (2 * Math.PI));
  return Math.abs(d) * DOME_R;
}

/** Mantiene al jugador dentro de la cúpula. Delante de la puerta se puede llegar hasta ella. */
export function clampToWorld(p: THREE.Vector3) {
  const r = Math.hypot(p.x, p.z);
  const lim = doorOffset(p.x, p.z) < DOOR.w / 2 - 0.3 ? DOME_R - 0.35 : WALK_R;
  if (r > lim) { p.x *= lim / r; p.z *= lim / r; }
}

/** ¿Está tocando la puerta? (la cruza → fundido a blanco y vuelta al inicio) */
export function atDoor(p: THREE.Vector3): boolean {
  return p.y < DOOR.h - 1.8 && doorOffset(p.x, p.z) < DOOR.w / 2 - 0.3 && Math.hypot(p.x, p.z) > DOME_R - 0.75;
}

const f = (x: number) => x.toFixed(4);
export const WORLD_GLSL = /* glsl */ `
#define DOME_R ${f(DOME_R)}
#define FIELD_SQ ${f(FIELD_SQ)}
`;
