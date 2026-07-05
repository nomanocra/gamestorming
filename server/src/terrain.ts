// ============================================================
//  RELIEF EN PALIERS — miroir EXACT de client/src/game.js.
//  Les constantes/formules DOIVENT rester identiques au client, sinon le
//  serveur et les clients ne s'accorderaient plus sur l'emplacement des
//  falaises (ennemis qui traversent, joueurs bloqués dans le vide, etc.).
// ============================================================
const CHUNK = 40;
const CELLS = 12;
const CELL = CHUNK / CELLS;   // ~3.333 u
const STEP = 3.0;             // hauteur d'un palier
const WATER_LEVEL = -1.4;

function hh(ix: number, iz: number): number {
  let s = (((ix | 0) * 374761393 + (iz | 0) * 668265263) >>> 0);
  s = ((s ^ (s >>> 13)) * 1274126177) >>> 0;
  return ((s ^ (s >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x: number, z: number): number {
  const x0 = Math.floor(x), z0 = Math.floor(z), fx = x - x0, fz = z - z0;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = hh(x0, z0), b = hh(x0 + 1, z0), c = hh(x0, z0 + 1), d = hh(x0 + 1, z0 + 1);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}
function baseHeight(x: number, z: number): number {
  const h = vnoise(x * 0.017 + 41.7, z * 0.017 + 12.3) * 1.00
          + vnoise(x * 0.045 + 91.1, z * 0.045 + 63.9) * 0.45
          + vnoise(x * 0.110 + 7.5,  z * 0.110 + 88.2) * 0.16;
  return (h / 1.61) * 2 - 1;
}
const PLAIN = 0.36;
const RELIEF = 5;
function levelFromBase(h: number): number {
  const t = Math.abs(h) - PLAIN;
  if (t <= 0) return 0;
  const l = 1 + Math.floor(t / ((1 - PLAIN) / RELIEF));
  return h > 0 ? l : -l;
}
const cellOf = (v: number) => Math.floor(v / CELL);
function cellLevel(ci: number, cj: number): number {
  return levelFromBase(baseHeight((ci + 0.5) * CELL, (cj + 0.5) * CELL));
}
function bridgeLevel(ci: number, cj: number): number | null {
  if (cellLevel(ci, cj) * STEP >= WATER_LEVEL) return null;
  const w = cellLevel(ci - 1, cj), e = cellLevel(ci + 1, cj);
  if (w === e && w * STEP >= WATER_LEVEL && hh(ci + 555, cj + 111) < 0.6) return w;
  const n = cellLevel(ci, cj - 1), s = cellLevel(ci, cj + 1);
  if (n === s && n * STEP >= WATER_LEVEL && hh(ci + 111, cj + 555) < 0.6) return n;
  return null;
}
function effLevel(ci: number, cj: number): number {
  const b = bridgeLevel(ci, cj);
  return b !== null ? b : cellLevel(ci, cj);
}
function hasConnector(hci: number, hcj: number, lci: number, lcj: number): boolean {
  return hh(hci * 131 + lci, hcj * 131 + lcj) < 0.33;
}
function edgePassable(ci: number, cj: number, ni: number, nj: number): boolean {
  const a = effLevel(ci, cj), b = effLevel(ni, nj);
  if (a === b) return true;
  return a > b ? hasConnector(ci, cj, ni, nj) : hasConnector(ni, nj, ci, cj);
}

export function terrainHeight(x: number, z: number): number {
  return effLevel(cellOf(x), cellOf(z)) * STEP;
}

// Déplacement avec collision de falaise (glisse le long des murs, axe par axe).
// Écrit la position corrigée dans `out` {x, z}.
export function moveWithCliffs(x: number, z: number, nx: number, nz: number, out: { x: number; z: number }) {
  const ci = cellOf(x), cj = cellOf(z);
  let rx = nx;
  const nci = cellOf(nx);
  if (nci !== ci && !edgePassable(ci, cj, nci, cj)) rx = x;
  const rci = cellOf(rx), ncj = cellOf(nz);
  let rz = nz;
  if (ncj !== cj && !edgePassable(rci, cj, rci, ncj)) rz = z;
  out.x = rx; out.z = rz;
}
