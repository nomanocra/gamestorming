import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import * as SkeletonUtils from "three/addons/utils/SkeletonUtils.js";
import { createArena, joinArenaById, leaveArena, listArenas, sendPos, sendHit, sendDensity, sendShot, onShot, sendGrab, onGrabbed, getRoom, getSessionId } from "./net/room";

// ============================================================
//  CONFIG CLASSEMENT MONDIAL (Supabase). Vide = high-score LOCAL.
// ============================================================
const LEADERBOARD = { supabaseUrl: "", supabaseKey: "" };

// Outils de test (curseur délai boss + touche B) : visibles UNIQUEMENT en local, pas en prod
const IS_LOCAL = ["localhost", "127.0.0.1", ""].includes(location.hostname);

// ---------- utils ----------
const rand = (a, b) => a + Math.random() * (b - a);
const pick = arr => arr[(Math.random() * arr.length) | 0];
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const dist2 = (ax, az, bx, bz) => { const dx = ax - bx, dz = az - bz; return dx * dx + dz * dz; };

// ---------- son ----------
let AC = null, soundOn = true;
function beep(freq, dur, type = "square", vol = 0.04) {
  if (!soundOn) return;
  try {
    if (!AC) AC = new (window.AudioContext || window.webkitAudioContext)();
    const o = AC.createOscillator(), g = AC.createGain();
    o.type = type; o.frequency.value = freq; g.gain.value = vol;
    o.connect(g); g.connect(AC.destination); o.start();
    g.gain.exponentialRampToValueAtTime(0.0001, AC.currentTime + dur); o.stop(AC.currentTime + dur);
  } catch (e) {}
}

// ============================================================
//  THREE : scène, caméra iso ortho, lumière, bloom
// ============================================================
const app = document.getElementById("app");
let W = window.innerWidth, H = window.innerHeight;
const R_ISLAND = 62;
const BULLET_Y = 1.6; // hauteur de vol des projectiles
const BOSS_TIME = 300; // 5 min avant le boss

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
renderer.setSize(W, H);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
renderer.outputColorSpace = THREE.SRGBColorSpace;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0a16);
scene.fog = new THREE.Fog(0x0a0a16, 55, 120);

// Caméra PERSPECTIVE (vraie profondeur / fuyantes) vue de haut.
let camera = new THREE.PerspectiveCamera(45, W / H, 0.1, 2000);
const CAM_OFF = new THREE.Vector3(26, 34, 26);

// --- Zoom adaptatif à N'IMPORTE QUEL ratio d'écran -------------------------
// Three.js garde le FOV *vertical* constant : le zoom perçu suit alors la
// hauteur de l'écran -> large&court = trop dézoomé, haut&étroit (portrait) =
// trop zoomé. On garde plutôt le FOV *diagonal* constant : la quantité de
// monde à l'écran reste stable quel que soit le ratio (un écran large zoome un
// peu, un écran haut dézoome, les deux se compensent au lieu de diverger).
const REF_FOV = 45;            // FOV vertical de référence...
const REF_ASPECT = 16 / 9;     // ...au ratio de référence
const TAN_DIAG = Math.tan(THREE.MathUtils.degToRad(REF_FOV) / 2) * Math.hypot(1, REF_ASPECT);
function applyCamAspect() {
  const a = W / H;
  camera.aspect = a;
  // FOV vertical tel que la demi-diagonale du frustum reste constante
  camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(TAN_DIAG / Math.hypot(1, a)));
  camera.updateProjectionMatrix();
}
applyCamAspect();

// lumières
const hemi = new THREE.HemisphereLight(0xbcd4ff, 0x3a2f4a, 0.8);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff0dd, 2.1);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 1; sun.shadow.camera.far = 200;
sun.shadow.camera.left = -60; sun.shadow.camera.right = 60;
sun.shadow.camera.top = 60; sun.shadow.camera.bottom = -60;
sun.shadow.bias = -0.0004;
scene.add(sun); scene.add(sun.target);

// bloom
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(W, H), 0.75, 0.6, 0.75);
composer.addPass(bloom);
composer.setSize(W, H);

window.addEventListener("resize", () => {
  W = window.innerWidth; H = window.innerHeight;
  renderer.setSize(W, H); composer.setSize(W, H); bloom.setSize(W, H); applyCamAspect();
});

// ============================================================
//  RELIEF EN PALIERS : hauteur DÉTERMINISTE (identique sur tous les clients)
//  -> inutile d'envoyer Y sur le réseau, chaque client le recalcule en local.
//  Le sol est quantifié en PALIERS plats. Deux cellules voisines :
//   • même palier / 1 marche (Δ=1)  -> franchissable (petite marche)
//   • falaise (Δ>=2)                -> INFRANCHISSABLE, sauf escalier/rampe (connecteur)
//  Des ponts relient certaines terres au-dessus de l'eau.
// ============================================================
const CHUNK = 40, VIEW = 4;            // taille d'un chunk, rayon de chunks chargés
const CELLS = 12;                      // cellules de terrain par chunk
const CELL  = CHUNK / CELLS;           // taille d'une cellule (~3.33 u)
const STEP  = 3.0;                     // hauteur d'un palier
const WATER_LEVEL = -1.4;              // sous ce niveau : eau (mares dans les creux)

function _hh(ix, iz) {                  // hash entier -> [0,1)
  let s = ((ix | 0) * 374761393 + (iz | 0) * 668265263) >>> 0;
  s = ((s ^ (s >>> 13)) * 1274126177) >>> 0;
  return ((s ^ (s >>> 16)) >>> 0) / 4294967296;
}
function _vnoise(x, z) {                // bruit de valeur lissé (smoothstep)
  const x0 = Math.floor(x), z0 = Math.floor(z), fx = x - x0, fz = z - z0;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = _hh(x0, z0), b = _hh(x0 + 1, z0), c = _hh(x0, z0 + 1), d = _hh(x0 + 1, z0 + 1);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}
// signal continu sous-jacent (normalisé ~[-1,1], moyenne ~0) — AVANT quantification
function baseHeight(x, z) {
  const h = _vnoise(x * 0.017 + 41.7, z * 0.017 + 12.3) * 1.00     // grandes formes
          + _vnoise(x * 0.045 + 91.1, z * 0.045 + 63.9) * 0.45     // reliefs moyens
          + _vnoise(x * 0.110 + 7.5,  z * 0.110 + 88.2) * 0.16;    // détail
  return (h / 1.61) * 2 - 1;            // -> ~[-1,1] centré sur 0
}
// Quantification en paliers avec une large BANDE MORTE centrale = vaste PLAINE (niveau 0)
// connectée où l'on court librement ; au-delà, des MESAS (+) et des CUVETTES/lacs (-)
// à flancs de falaise. => grand terrain jouable + reliefs francs qu'on ne gravit PAS.
const PLAIN = 0.36;                     // demi-largeur de la plaine (part du signal en niveau 0)
const RELIEF = 5;                       // nb max de paliers de chaque côté de la plaine
function levelFromBase(h) {
  const t = Math.abs(h) - PLAIN;
  if (t <= 0) return 0;
  const l = 1 + Math.floor(t / ((1 - PLAIN) / RELIEF));
  return h > 0 ? l : -l;
}
const cellOf = v => Math.floor(v / CELL);
// palier (entier) d'une cellule : niveau du signal au centre de la cellule
function cellLevel(ci, cj) { return levelFromBase(baseHeight((ci + 0.5) * CELL, (cj + 0.5) * CELL)); }
// pont : une cellule d'eau reliée par deux terres opposées de même palier -> tablier praticable
function bridgeLevel(ci, cj) {
  if (cellLevel(ci, cj) * STEP >= WATER_LEVEL) return null;        // pas de l'eau
  const w = cellLevel(ci - 1, cj), e = cellLevel(ci + 1, cj);
  if (w === e && w * STEP >= WATER_LEVEL && _hh(ci + 555, cj + 111) < 0.6) return w;
  const n = cellLevel(ci, cj - 1), s = cellLevel(ci, cj + 1);
  if (n === s && n * STEP >= WATER_LEVEL && _hh(ci + 111, cj + 555) < 0.6) return n;
  return null;
}
// palier EFFECTIF (tient compte des ponts) -> c'est la surface où l'on marche
function effLevel(ci, cj) { const b = bridgeLevel(ci, cj); return b !== null ? b : cellLevel(ci, cj); }
// connecteur (escalier/rampe) : SEUL moyen de franchir une falaise, placé de façon
// déterministe sur ~1 bord de falaise sur 3. Ailleurs, la falaise est infranchissable.
function hasConnector(hci, hcj, lci, lcj) { return _hh(hci * 131 + lci, hcj * 131 + lcj) < 0.33; }
// un bord entre cellule (ci,cj) et voisine (ni,nj) est-il PRATICABLE ?
function edgePassable(ci, cj, ni, nj) {
  const a = effLevel(ci, cj), b = effLevel(ni, nj);
  if (a === b) return true;                                         // même palier -> libre
  return a > b ? hasConnector(ci, cj, ni, nj) : hasConnector(ni, nj, ci, cj);  // TOUT dénivelé = falaise
}
// niveau EFFECTIF au point monde (x,z)
function levelAt(x, z) { return effLevel(cellOf(x), cellOf(z)); }
// hauteur du SOL (surface plate du palier) au point (x,z) — utilisée PARTOUT
function terrainHeight(x, z) { return levelAt(x, z) * STEP; }
// déplacement avec COLLISION de falaise : glisse le long des murs infranchissables,
// axe par axe (joueur ET ennemis passent par ici). Renvoie la position corrigée.
const _mv = { x: 0, z: 0 };
function moveWithCliffs(x, z, nx, nz) {
  const ci = cellOf(x), cj = cellOf(z);
  let rx = nx;
  const nci = cellOf(nx);
  if (nci !== ci && !edgePassable(ci, cj, nci, cj)) rx = x;       // mur en X -> bloqué sur X
  const rci = cellOf(rx), ncj = cellOf(nz);
  let rz = nz;
  if (ncj !== cj && !edgePassable(rci, cj, rci, ncj)) rz = z;     // mur en Z -> bloqué sur Z
  _mv.x = rx; _mv.z = rz; return _mv;
}

// couleur d'une surface de palier selon sa hauteur (sable -> herbe -> terre haute -> pierre)
const _tc = new THREE.Color();
function terraceColor(h, jitter) {
  const col = h < WATER_LEVEL + 0.3 ? 0xcbb784
            : h < STEP * 0.5        ? 0x5f9048
            : h < STEP * 1.5        ? 0x4c8038
            : h < STEP * 2.5        ? 0x7d8a5a
            :                         0x9aa0ac;
  _tc.setHex(col);
  _tc.offsetHSL(0, 0, (jitter - 0.5) * 0.10);
  return _tc;
}
const COL_CLIFF = new THREE.Color(0x6f6353);      // paroi de falaise (terre/roche)
const COL_STEP  = new THREE.Color(0x8a7d63);      // flanc d'une simple marche
const COL_RAMP  = new THREE.Color(0xb79b6a);      // escalier / rampe (pierre claire)
const COL_BRIDGE = new THREE.Color(0x7a5a38);     // planches de pont

// ============================================================
//  MONDE INFINI : terrain + props générés par chunks autour du joueur
// ============================================================
// eau : grand plan translucide recentré sur le joueur ; les creux du terrain y baignent
const water = new THREE.Mesh(new THREE.PlaneGeometry(700, 700),
  new THREE.MeshStandardMaterial({ color: 0x2f7fd0, transparent: true, opacity: 0.6, roughness: 0.2, metalness: 0.25 }));
water.rotation.x = -Math.PI / 2; water.position.y = WATER_LEVEL; scene.add(water);

// terrain : une tuile en PALIERS par chunk (tops plats + parois de falaise + escaliers/ponts)
// DoubleSide : évite tout souci d'orientation de face sur les parois et les marches.
const terrainMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1.0, side: THREE.DoubleSide });
const terrainMeshes = [];                         // tuiles visibles -> raycast visée/déplacement
const _P = [], _C = [];                            // buffers réutilisés (positions / couleurs)
function _tri(ax, ay, az, bx, by, bz, cx, cy, cz, col) {
  _P.push(ax, ay, az, bx, by, bz, cx, cy, cz);
  for (let k = 0; k < 3; k++) _C.push(col.r, col.g, col.b);
}
function _quad(p1, p2, p3, p4, col) {              // p = [x,y,z] ; 2 triangles
  _tri(p1[0], p1[1], p1[2], p2[0], p2[1], p2[2], p3[0], p3[1], p3[2], col);
  _tri(p1[0], p1[1], p1[2], p3[0], p3[1], p3[2], p4[0], p4[1], p4[2], col);
}
// ESCALIER visible : marches qui descendent du haut (H) au bas (Hn) en s'avançant
// dans la cellule basse. (ex0,ez0)-(ex1,ez1) = arête partagée ; (sx,sz) = sens de descente.
function _stairs(ex0, ez0, ex1, ez1, sx, sz, H, Hn, col) {
  const n = Math.max(1, Math.round((H - Hn) / 1.1));   // ~1 marche par 1.1 u de dénivelé
  const run = CELL * 0.94;
  for (let s = 0; s < n; s++) {
    const yTop = H - (H - Hn) * (s / n), yBot = H - (H - Hn) * ((s + 1) / n);
    const d0 = (s / n) * run, d1 = ((s + 1) / n) * run;
    const gTop0 = [ex0 + sx * d0, yTop, ez0 + sz * d0], gTop1 = [ex1 + sx * d0, yTop, ez1 + sz * d0];
    const gEnd0 = [ex0 + sx * d1, yTop, ez0 + sz * d1], gEnd1 = [ex1 + sx * d1, yTop, ez1 + sz * d1];
    _quad(gTop0, gTop1, gEnd1, gEnd0, col);            // giron (dessus de la marche)
    const rBot0 = [ex0 + sx * d0, yBot, ez0 + sz * d0], rBot1 = [ex1 + sx * d0, yBot, ez1 + sz * d0];
    _quad(rBot0, rBot1, gTop1, gTop0, col);            // contremarche (face verticale)
  }
}
function buildTerrainTile(cx, cz) {
  _P.length = 0; _C.length = 0;
  const ci0 = cx * CELLS, cj0 = cz * CELLS;
  for (let a = 0; a < CELLS; a++) for (let b = 0; b < CELLS; b++) {
    const ci = ci0 + a, cj = cj0 + b;
    const L = effLevel(ci, cj), H = L * STEP;
    const x0 = ci * CELL, x1 = x0 + CELL, z0 = cj * CELL, z1 = z0 + CELL;
    const jit = _hh(ci * 7, cj * 7);
    // dessus plat du palier (ou tablier de pont)
    const isBridge = bridgeLevel(ci, cj) !== null;
    const topCol = isBridge ? COL_BRIDGE : terraceColor(H, jit);
    _quad([x0, H, z0], [x0, H, z1], [x1, H, z1], [x1, H, z0], topCol);
    // vers chaque voisin PLUS BAS (construit une seule fois, par la cellule HAUTE) :
    //  - avec connecteur -> ESCALIER praticable ; sinon -> paroi de FALAISE infranchissable
    const nb = [[ci - 1, cj, x0, z0, x0, z1], [ci + 1, cj, x1, z1, x1, z0],
                [ci, cj - 1, x1, z0, x0, z0], [ci, cj + 1, x0, z1, x1, z1]];
    for (const [ni, nj, ex0, ez0, ex1, ez1] of nb) {
      const Ln = effLevel(ni, nj), Hn = Ln * STEP;
      if (Ln >= L) continue;                         // seul le côté HAUT construit la paroi
      if (hasConnector(ci, cj, ni, nj)) {            // ACCÈS -> escalier visible
        _stairs(ex0, ez0, ex1, ez1, Math.sign(ni - ci), Math.sign(nj - cj), H, Hn, COL_RAMP);
      } else {                                        // pas d'accès -> falaise verticale pleine
        _quad([ex0, Hn, ez0], [ex1, Hn, ez1], [ex1, H, ez1], [ex0, H, ez0], (L - Ln) >= 2 ? COL_CLIFF : COL_STEP);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(_P), 3));
  geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(_C), 3));
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, terrainMat);
  m.receiveShadow = true; m.castShadow = false;
  return m;
}

// assets de props PARTAGÉS (géométries/matériaux réutilisés -> pas de fuite mémoire)
const trunkGeo = new THREE.CylinderGeometry(0.35, 0.4, 1.2, 5);
const topGeo   = new THREE.ConeGeometry(1.6, 4, 6);
const rockGeo  = new THREE.IcosahedronGeometry(1, 0);
const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2f, flatShading: true });
// roches de teintes variées (granit clair, gris bleuté, ocre, ardoise)
const rockMats = [0x8a8f9c, 0x9aa0ac, 0xa7906f, 0x6f747f].map(c => new THREE.MeshStandardMaterial({ color: c, flatShading: true }));
const topMats  = [0xe86fa0, 0x8fd67a, 0x7ec8e3, 0xf0c85a, 0x6db85a, 0xc8e070].map(c => new THREE.MeshStandardMaterial({ color: c, flatShading: true }));

// PRNG déterministe par chunk -> un chunk se régénère IDENTIQUE si on y revient
function chunkRand(cx, cz, i) {
  let s = (cx * 374761393 + cz * 668265263 + i * 1274126177) >>> 0;
  s = ((s ^ (s >>> 13)) * 1274126177) >>> 0;
  return ((s ^ (s >>> 16)) >>> 0) / 4294967296;
}
const loadedChunks = new Map();
function buildChunk(cx, cz) {
  const g = new THREE.Group();
  const tile = buildTerrainTile(cx, cz);                // sol en relief de ce chunk
  g.add(tile); g.userData.tile = tile; terrainMeshes.push(tile);
  const n = 3 + Math.floor(chunkRand(cx, cz, 0) * 6);   // 3 à 8 props par chunk
  for (let i = 0; i < n; i++) {
    const rx = chunkRand(cx, cz, i*4+1), rz = chunkRand(cx, cz, i*4+2);
    const rt = chunkRand(cx, cz, i*4+3), rs = chunkRand(cx, cz, i*4+4);
    const x = cx * CHUNK + rx * CHUNK, z = cz * CHUNK + rz * CHUNK;
    const gy = terrainHeight(x, z);                     // altitude du sol sous le prop
    if (gy < WATER_LEVEL) continue;                      // pas de prop dans l'eau
    let m;
    if (rt < 0.55) { // arbre
      const grp = new THREE.Group();
      const trunk = new THREE.Mesh(trunkGeo, trunkMat); trunk.position.y = 0.6; trunk.castShadow = true;
      const top = new THREE.Mesh(topGeo, topMats[Math.floor(rs * topMats.length) % topMats.length]);
      top.position.y = 3; top.castShadow = true; top.scale.setScalar(0.8 + rs * 0.6);
      grp.add(trunk, top); m = grp;
      m.position.y = gy;
    } else { // rocher
      m = new THREE.Mesh(rockGeo, rockMats[Math.floor(rt * rockMats.length) % rockMats.length]); const s = 1 + rs * 1.2;
      m.scale.setScalar(s); m.position.y = gy + 0.55 * s; m.castShadow = true;
      m.rotation.set(rx * 6, rz * 6, rt * 6);
    }
    m.position.x = x; m.position.z = z; g.add(m);
  }
  scene.add(g); loadedChunks.set(cx + "," + cz, g);
}
let lastChunkKey = "";
function updateChunks(px, pz) {
  const fx = Math.floor(px / CHUNK), fz = Math.floor(pz / CHUNK);
  const key = fx + "," + fz;
  if (key === lastChunkKey) return;  // ne recalcule que quand on change de chunk
  lastChunkKey = key;
  const need = new Set();
  for (let dx = -VIEW; dx <= VIEW; dx++) for (let dz = -VIEW; dz <= VIEW; dz++) {
    const k = (fx + dx) + "," + (fz + dz); need.add(k);
    if (!loadedChunks.has(k)) buildChunk(fx + dx, fz + dz);
  }
  for (const [k, g] of loadedChunks) if (!need.has(k)) {                // décharge derrière
    scene.remove(g);
    const ti = terrainMeshes.indexOf(g.userData.tile); if (ti >= 0) terrainMeshes.splice(ti, 1);
    g.userData.tile.geometry.dispose();
    loadedChunks.delete(k);
  }
}
updateChunks(0, 0);

// ---------- géométries/matériaux partagés (perf) ----------
const GEO = {
  bullet: new THREE.IcosahedronGeometry(0.32, 0),
  grunt: new THREE.IcosahedronGeometry(1.1, 0),
  runner: new THREE.ConeGeometry(0.75, 1.6, 6),
  brute: new THREE.DodecahedronGeometry(2.0, 0),
  orb: new THREE.IcosahedronGeometry(0.55, 0),
  particle: new THREE.BoxGeometry(0.25, 0.25, 0.25),
};
const MAT = {
  grunt: new THREE.MeshStandardMaterial({ color: 0x8a6cf0, emissive: 0x4a2fb0, emissiveIntensity: 0.5, flatShading: true }),
  runner: new THREE.MeshStandardMaterial({ color: 0x4fd0ff, emissive: 0x2090c0, emissiveIntensity: 0.6, flatShading: true }),
  brute: new THREE.MeshStandardMaterial({ color: 0xd85a4a, emissive: 0x902010, emissiveIntensity: 0.5, flatShading: true }),
};
function bulletMat(col) { return new THREE.MeshBasicMaterial({ color: col }); }

// ---------- feedback visuel : bouclier + preview de visée (feedforward) ----------
const shieldMesh = new THREE.Mesh(new THREE.SphereGeometry(1.9, 18, 14),
  new THREE.MeshBasicMaterial({ color: 0x5cc8ff, transparent: true, opacity: 0.22, depthWrite: false }));
shieldMesh.visible = false; scene.add(shieldMesh);

// preview BOMBE : disque + anneau au rayon d'explosion (11)
const bombPrev = new THREE.Group();
{
  const disc = new THREE.Mesh(new THREE.CircleGeometry(11, 40),
    new THREE.MeshBasicMaterial({ color: 0xff7a4a, transparent: true, opacity: 0.16, depthWrite: false }));
  disc.rotation.x = -Math.PI / 2;
  const ring = new THREE.Mesh(new THREE.TorusGeometry(11, 0.3, 8, 48), new THREE.MeshBasicMaterial({ color: 0xff7a4a }));
  ring.rotation.x = -Math.PI / 2;
  bombPrev.add(disc, ring);
}
bombPrev.visible = false; scene.add(bombPrev);

// preview LASER : rayon transparent depuis le joueur
const laserPrev = new THREE.Mesh(new THREE.BoxGeometry(100, 0.6, 3.2),
  new THREE.MeshBasicMaterial({ color: 0xff4ad0, transparent: true, opacity: 0.22, depthWrite: false }));
laserPrev.visible = false; scene.add(laserPrev);

// preview RICOCHET : marqueur de cible
const grenadePrev = new THREE.Mesh(new THREE.TorusGeometry(2, 0.22, 8, 28), new THREE.MeshBasicMaterial({ color: 0xb98cff }));
grenadePrev.rotation.x = -Math.PI / 2; grenadePrev.visible = false; scene.add(grenadePrev);

const aimPoint = new THREE.Vector3();
function updateAimPreview() {
  bombPrev.visible = laserPrev.visible = grenadePrev.visible = false;
  if (state !== "play" || armed === -1 || !player) return;
  if (IS_TOUCH && !aiming) return;   // sur tactile : preview seulement quand le doigt vise
  const key = player.inv[armed]; if (!key) return;
  camera.updateMatrixWorld();
  raycaster.setFromCamera(mouseNDC, camera);
  if (!raycastGround(aimPoint)) return;
  if (key === "bombe") {
    bombPrev.visible = true; bombPrev.position.set(aimPoint.x, terrainHeight(aimPoint.x, aimPoint.z) + 0.06, aimPoint.z);
  } else if (key === "laser") {
    const a = Math.atan2(aimPoint.z - player.z, aimPoint.x - player.x);
    const lx = player.x + Math.cos(a) * 50, lz = player.z + Math.sin(a) * 50;
    laserPrev.visible = true;
    laserPrev.position.set(lx, terrainHeight(lx, lz) + 0.9, lz);
    laserPrev.rotation.y = -a;
  } else if (key === "grenade") {
    grenadePrev.visible = true; grenadePrev.position.set(aimPoint.x, terrainHeight(aimPoint.x, aimPoint.z) + 0.06, aimPoint.z);
  }
}

// ---------- joueur : renard 3D animé (CC0, GLTFLoader) ----------
const FACE_OFFSET = 0;  // ajuste si le perso regarde à l'envers (0, PI, ±PI/2)
const TARGET_H = 2.0;     // hauteur cible du personnage (auto-scale, peu importe le modèle)
let mixer = null, actIdle = null, actRun = null, charReady = false;
// prototype scalé + clips : sert à CLONER un avatar par joueur distant (co-op)
let charProto = null, charClips = null;
function findClip(clips, ...keys) {   // trouve un clip par mot-clé (insensible à la casse)
  for (const k of keys) { const c = clips.find(cl => cl.name.toLowerCase().includes(k)); if (c) return c; }
  return null;
}
new GLTFLoader().load("assets/Barbarian.glb", g => {
  const char = g.scene;
  // auto-scale FIABLE : matrices monde à jour AVANT de mesurer, puis on ramène à TARGET_H
  char.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(char);
  const h = box.getSize(new THREE.Vector3()).y || 1;
  char.scale.multiplyScalar(TARGET_H / h);
  char.traverse(o => { if (o.isMesh) o.castShadow = true; });
  if (playerMesh && playerMesh !== char) scene.remove(playerMesh); // vire le fallback primitif
  playerMesh = char; scene.add(char);
  char.visible = (state === "play");
  mixer = new THREE.AnimationMixer(char);
  const clips = g.animations;
  charProto = char; charClips = clips;   // dispo pour cloner les avatars distants
  const idleClip = findClip(clips, "idle") || clips[0];
  actIdle = mixer.clipAction(idleClip);
  actRun  = mixer.clipAction(findClip(clips, "running", "run", "walk", "sprint", "jog") || idleClip);
  actIdle.play(); actRun.play(); actIdle.weight = 1; actRun.weight = 0;
  charReady = true;
}, undefined, err => console.warn("Character load failed", err));

// ---------- fallback : personnage low-poly primitif (le temps du chargement) ----------
function buildPlayerMesh() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.7, 0.7, 4, 10),
    new THREE.MeshStandardMaterial({ color: 0x3a6ff0, emissive: 0x1030a0, emissiveIntensity: 0.35, flatShading: true }));
  body.position.y = 1.0; body.castShadow = true; g.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.62, 12, 10),
    new THREE.MeshStandardMaterial({ color: 0xf2c48a, flatShading: true }));
  head.position.y = 1.95; head.castShadow = true; g.add(head);
  for (const s of [-1, 1]) { // oreilles
    const ear = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.5, 5),
      new THREE.MeshStandardMaterial({ color: 0xf2c48a, flatShading: true }));
    ear.position.set(0.3 * s, 2.45, 0); g.add(ear);
  }
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.4, 6),
    new THREE.MeshBasicMaterial({ color: 0xffffff }));
  nose.rotation.x = Math.PI / 2; nose.position.set(0, 1.9, 0.55); g.add(nose);
  return g;
}

// ---------- compagnon volant (le "totem" qui tire) ----------
function buildPetMesh() {
  const g = new THREE.Group();
  const col = 0x38e0ff;
  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.55, 0),
    new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 1.8, flatShading: true }));
  g.add(core);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.95, 0.09, 8, 24),
    new THREE.MeshStandardMaterial({ color: 0xfff0a0, emissive: 0xffcf5a, emissiveIntensity: 1.6 }));
  ring.rotation.x = Math.PI / 2; g.add(ring); g.userData.ring = ring;
  for (const s of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 8), new THREE.MeshBasicMaterial({ color: 0x10101f }));
    eye.position.set(0.18 * s, 0.12, 0.5); g.add(eye);
  }
  const light = new THREE.PointLight(col, 6, 16, 2); g.add(light);
  return g;
}

// ---------- icône emoji sur sprite (face caméra) ----------
function makeIconSprite(emoji) {
  const c = document.createElement("canvas"); c.width = c.height = 128;
  const cx = c.getContext("2d");
  cx.font = "92px system-ui"; cx.textAlign = "center"; cx.textBaseline = "middle";
  cx.fillText(emoji, 64, 74);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false }));
  spr.scale.set(1.8, 1.8, 1.8);
  return spr;
}

// ---------- barre de vie flottante (billboard face caméra) ----------
function makeHpBar(width) {
  const g = new THREE.Group();
  const bg = new THREE.Mesh(new THREE.PlaneGeometry(width, 0.32), new THREE.MeshBasicMaterial({ color: 0x1a0505 }));
  const fill = new THREE.Mesh(new THREE.PlaneGeometry(width, 0.32), new THREE.MeshBasicMaterial({ color: 0x3ad13a }));
  fill.position.z = 0.01;
  g.add(bg); g.add(fill); g.userData = { fill, w: width }; g.visible = false;
  scene.add(g);
  return g;
}

// ============================================================
//  DÉFINITIONS (armes, objets, buffs) — mêmes valeurs que la 2D
// ============================================================
const BASE_WEAPONS = {
  pistolet:    { name:"Pistolet",     ico:"🔫", dmg:10, fireInt:0.5,  projSpeed:42, count:1, spread:0,    pierce:0, col:0xffe98a },
  mitraillette:{ name:"Mitraillette", ico:"💨", dmg:6,  fireInt:0.16, projSpeed:48, count:1, spread:0.05, pierce:0, col:0xffd24a },
  pompe:       { name:"Fusil à pompe",ico:"💥", dmg:8,  fireInt:0.7,  projSpeed:42, count:5, spread:0.20, pierce:0, col:0xffb060 },
  canon:       { name:"Canon lourd",  ico:"☄️", dmg:34, fireInt:1.0,  projSpeed:36, count:1, spread:0,    pierce:4, col:0xff8a5a },
  triple:      { name:"Tri-tir",      ico:"🔱", dmg:9,  fireInt:0.42, projSpeed:44, count:3, spread:0.18, pierce:1, col:0xa8ff8a },
  flamme:      { name:"Lance-flammes",ico:"🔥", dmg:3,  fireInt:0.05, projSpeed:24, count:3, spread:0.30, pierce:1, col:0xff5a2a, life:0.4 },
};
const WEAPON_KEYS = Object.keys(BASE_WEAPONS);
// Stats d'une arme selon son NIVEAU : + de dégâts, tir + rapide, + de projectiles/perçage
function computeWeapon(key, lvl) {
  const b = BASE_WEAPONS[key];
  return {
    key, name: b.name, ico: b.ico, col: b.col, life: b.life, spread: b.spread, projSpeed: b.projSpeed, lvl,
    dmg: b.dmg * (1 + 0.35 * (lvl - 1)),                 // +35% de dégâts par niveau
    fireInt: b.fireInt * Math.pow(0.93, lvl - 1),        // tire un peu plus vite
    count: b.count + Math.floor((lvl - 1) / 3),          // +1 projectile tous les 3 niveaux
    pierce: b.pierce + Math.floor((lvl - 1) / 4),        // +1 perçage tous les 4 niveaux
  };
}
const ITEMS = { bombe:{ name:"Bombe", ico:"💣", col:0xff7a4a }, laser:{ name:"Laser", ico:"🔺", col:0x6cf0ff }, grenade:{ name:"Boomerang", ico:"🪃", col:0xb98cff } };
const ITEM_KEYS = Object.keys(ITEMS);
const BUFFS = {
  bouclier:{ ico:"🛡️", col:0x7cccff, apply:p => p.shield = Math.max(p.shield, 6) },
  vitesse: { ico:"👟", col:0x9fff8a, apply:p => p.speedBuff = 8 },
  frenesie:{ ico:"⚡", col:0xff9a66, apply:p => p.frenzy = 8 },
  soin:    { ico:"❤️", col:0xff6a6a, apply:p => p.hp = Math.min(p.maxHp, p.hp + 40) },
};
const BUFF_KEYS = Object.keys(BUFFS);
// pioche pondérée : le soin (vie) est ~2x plus rare que les autres buffs
const BUFF_POOL = ["bouclier", "bouclier", "vitesse", "vitesse", "frenesie", "frenesie", "soin"];

// ============================================================
//  ÉTAT
// ============================================================
let state = "menu";
let player, playerMesh, petMesh, enemies, bullets, pickups, effects, particles;
let gameTime = 0, spawnTimer = 0, kills = 0, score = 0, armed = -1, shake = 0, scoreSaved = false;
let boss = null, enemyBullets = [], nextBossTime = BOSS_TIME, bossDelay = BOSS_TIME;

function newPlayer() {
  return { x: 0, z: 0, r: 1.2, baseSpeed: 16, iframe: 0, hp: 100, maxHp: 100,
    weaponLvl: { pistolet: 1 }, weapon: computeWeapon("pistolet", 1), fireT: 0, inv: [null, null, null],
    shield: 0, speedBuff: 0, frenzy: 0, face: 0, moveTarget: null,
    get speed() { return this.baseSpeed * (this.speedBuff > 0 ? 1.6 : 1); } };
}
function clearGroup(list) { for (const e of list) { if (e.mesh) scene.remove(e.mesh); if (e.bar) scene.remove(e.bar); } }

// Pseudo courant (menu ou stocké). Persisté pour les prochaines sessions.
function getPseudo() {
  const el = document.getElementById("pseudoInput");
  const n = (((el && el.value) || localStorage.getItem("hs_name") || "Joueur").trim() || "Joueur").slice(0, 12);
  localStorage.setItem("hs_name", n);
  return n;
}

// Bascule entre les écrans d'overlay (pseudo / lobby / mort). null = tout cacher (en jeu).
function showScreen(id) {
  for (const s of ["pseudoScreen", "lobbyScreen", "deathScreen"]) {
    const el = document.getElementById(s);
    if (el) el.classList.toggle("hidden", s !== id);
  }
}

// Réinitialise la partie locale et bascule en mode jeu. Appelé après create/join.
function enterPlay() {
  if (enemies) { clearGroup(enemies); clearGroup(bullets); clearGroup(pickups); clearGroup(effects); clearGroup(particles); clearGroup(enemyBullets); }
  // les miroirs du serveur pointent vers des meshes qu'on vient de retirer -> on repart propre
  netEnemies.clear(); netPickups.clear();
  for (const s of remoteShots) scene.remove(s.mesh); remoteShots.length = 0;
  player = newPlayer();
  if (!playerMesh) { playerMesh = buildPlayerMesh(); scene.add(playerMesh); }
  playerMesh.visible = true;
  if (!petMesh) { petMesh = buildPetMesh(); scene.add(petMesh); }
  petMesh.visible = true;
  enemies = []; bullets = []; pickups = []; effects = []; particles = []; enemyBullets = [];
  gameTime = 0; spawnTimer = 0; kills = 0; score = 0; armed = -1; shake = 0; scoreSaved = false;
  boss = null; nextBossTime = bossDelay;
  sentDensity = -1; // force le renvoi de la densité au serveur (utile si on est l'hôte)
  stopPartyPoll(); // plus besoin de rafraîchir la liste des parties en jeu
  showScreen(null);
  document.getElementById("hud").classList.remove("hidden");
  state = "play"; lastT = performance.now();
}

// CRÉER une partie : ce joueur devient l'hôte et fixe les paramètres.
function createGame() {
  if (!AC) try { AC = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {}
  const bs = document.getElementById("bossSlider");
  const ds = document.getElementById("densSlider");
  bossDelay = bs ? +bs.value : BOSS_TIME;
  wantDensity = ds ? +ds.value : 1;
  const partyName = (document.getElementById("partyNameInput")?.value || "").trim();
  createArena(getPseudo(), partyName, { density: wantDensity, bossDelay });
  enterPlay();
}

// REJOINDRE une partie : les paramètres appartiennent à l'hôte (serveur autoritaire).
function joinGame(roomId) {
  if (!AC) try { AC = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {}
  stopPartyPoll();
  bossDelay = BOSS_TIME; wantDensity = 1; // valeurs locales sans effet en co-op (horde serveur)
  joinArenaById(roomId, getPseudo());
  enterPlay();
}

// Retour au lobby (après la mort). Quitte la partie et rouvre la liste des parties.
function backToMenu() {
  leaveArena();
  state = "menu";
  if (playerMesh) playerMesh.visible = false;
  if (petMesh) petMesh.visible = false;
  document.getElementById("hud").classList.add("hidden");
  openLobby();
}

// ============================================================
//  INPUT
// ============================================================
const keys = {};
const PREVENT = ["ArrowUp","ArrowDown","ArrowLeft","ArrowRight","Space"];
window.addEventListener("keydown", e => {
  keys[e.code] = true;
  if (e.code === "KeyM") soundOn = !soundOn;
  if (e.code === "KeyP" && (state === "play" || state === "pause")) togglePause();
  if (e.code === "KeyR" && state === "dead") backToMenu();
  if (e.code === "KeyB" && IS_LOCAL && state === "play" && !boss) {   // debug local : boss tout de suite
    nextBossTime = gameTime;
    for (const en of enemies) { scene.remove(en.mesh); scene.remove(en.bar); }
    enemies.length = 0;
  }
  const m = e.code.match(/^(?:Digit|Numpad)([1-3])$/);
  if (m && state === "play") armSlot(+m[1] - 1);
  if (PREVENT.includes(e.code)) e.preventDefault();
});
window.addEventListener("keyup", e => { keys[e.code] = false; });

let mouseNDC = new THREE.Vector2(0, 0);
const raycaster = new THREE.Raycaster();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
let dragging = false, aiming = false;
const _rayHits = [];
// point du sol (relief) sous le rayon courant : raycast des tuiles, repli sur le plan y=0
function raycastGround(out) {
  _rayHits.length = 0;
  raycaster.intersectObjects(terrainMeshes, false, _rayHits);
  if (_rayHits.length) { out.copy(_rayHits[0].point); return out; }
  return raycaster.ray.intersectPlane(groundPlane, out);
}
function pointerToGround(e, out) {   // met à jour la visée + renvoie le point au sol sous le doigt/souris
  mouseNDC.x = (e.clientX / W) * 2 - 1; mouseNDC.y = -(e.clientY / H) * 2 + 1;
  raycaster.setFromCamera(mouseNDC, camera);
  return raycastGround(out);
}
// pointerdown : objet armé -> on VISE (preview qui suit le doigt) ; sinon -> déplacement (drag)
renderer.domElement.addEventListener("pointerdown", e => {
  if (state !== "play" || !player) return;
  const hit = new THREE.Vector3();
  if (!pointerToGround(e, hit)) return;
  try { renderer.domElement.setPointerCapture(e.pointerId); } catch (_) {}
  if (armed !== -1) { aiming = true; }                       // le tir se fera au relâchement
  else { dragging = true; player.moveTarget = { x: hit.x, z: hit.z }; }
});
// pointermove : met à jour la visée (le preview suit le doigt) ; en drag, le perso suit le doigt
renderer.domElement.addEventListener("pointermove", e => {
  const hit = new THREE.Vector3();
  if (!pointerToGround(e, hit)) return;
  if (dragging && armed === -1 && state === "play" && player) player.moveTarget = { x: hit.x, z: hit.z };
});
// pointerup : si on visait un objet -> on le lance à l'endroit relâché
window.addEventListener("pointerup", e => {
  if (aiming && armed !== -1 && state === "play" && player) {
    const hit = new THREE.Vector3();
    if (pointerToGround(e, hit)) useItem(armed, hit.x, hit.z);
  }
  dragging = false; aiming = false;
});
window.addEventListener("pointercancel", () => { dragging = false; aiming = false; });

// slots cliquables (tap sur mobile)
document.querySelectorAll(".slot").forEach(el => {
  el.addEventListener("pointerdown", () => { if (state === "play") armSlot(+el.dataset.i); });
});
function togglePause() { if (state === "play") state = "pause"; else if (state === "pause") { state = "play"; lastT = performance.now(); } }

// ============================================================
//  INVENTAIRE / OBJETS
// ============================================================
function armSlot(i) { if (!player.inv[i]) { armed = -1; return; } armed = (armed === i) ? -1 : i; beep(520, 0.04, "sine", 0.03); }
function addItem(key) { const f = player.inv.indexOf(null); if (f === -1) return false; player.inv[f] = key; return true; }
function useItem(slot, wx, wz) {
  const key = player.inv[slot]; if (!key) return;
  const coop = inCoop();
  if (key === "bombe") {
    explode(wx, wz, 11, 130); shake = 0.5;
    if (coop) sendShot({ k:"bombe", x:wx, z:wz });
  } else if (key === "laser") {
    const a = Math.atan2(wz - player.z, wx - player.x);
    effects.push(mkLaser(a));
    if (coop) sendShot({ k:"laser", x:player.x, z:player.z, a });
    beep(300, 0.5, "sawtooth", 0.05);
  } else if (key === "grenade") {
    const a = Math.atan2(wz - player.z, wx - player.x);
    const m = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.25, 0.5),
      new THREE.MeshStandardMaterial({ color: 0xb98cff, emissive: 0xb98cff, emissiveIntensity: 1.7, flatShading: true }));
    m.position.set(player.x, BULLET_Y, player.z); scene.add(m);
    effects.push({ type:"boomerang", x:player.x, z:player.z, vx:Math.cos(a)*42, vz:Math.sin(a)*42, speed:42, life:5, r:1.1, dmg:32, bounces:6, hit:new Set(), mesh:m });
    if (coop) sendShot({ k:"boomerang", x:player.x, z:player.z, a });
    beep(520, 0.1, "square", 0.04);
  }
  player.inv[slot] = null; armed = -1;
}
function mkLaser(ang) {
  const len = 100;
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(len, 0.7, 0.7), new THREE.MeshBasicMaterial({ color: 0xff4ad0 }));
  scene.add(mesh);
  return { type:"laser", ang, life:0.9, max:0.9, dps:90, len, mesh };
}
function explode(x, z, radius, dmg) {
  for (const e of enemies) if (dist2(x, z, e.x, e.z) < (radius + e.r) ** 2) { damageEnemy(e, dmg); e.flash = 0.1; }
  spawnParticles(x, z, 0xff9a4a, 22);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1, 0.4, 6, 24), new THREE.MeshBasicMaterial({ color: 0xff9a4a }));
  ring.rotation.x = -Math.PI / 2; ring.position.set(x, terrainHeight(x, z) + 0.5, z); scene.add(ring);
  effects.push({ type:"boom", life:0.4, max:0.4, radius, mesh:ring });
  beep(90, 0.3, "sawtooth", 0.06);
}
function laserDamage(x1, z1, x2, z2, dmg, w) {
  for (const e of enemies) {
    const dx = x2 - x1, dz = z2 - z1, L2 = dx*dx + dz*dz || 1;
    let t = ((e.x - x1) * dx + (e.z - z1) * dz) / L2; t = clamp(t, 0, 1);
    const px = x1 + t * dx, pz = z1 + t * dz;
    if (dist2(e.x, e.z, px, pz) < (w + e.r) ** 2) { damageEnemy(e, dmg); e.flash = 0.1; }
  }
}

// ============================================================
//  SPAWN / DROPS
// ============================================================
function enemyType() {
  const t = gameTime, r = Math.random();
  if (t > 55 && r < 0.15) return { key:"brute", r:2.0, speed:3.9, hp:70+t*1.3, dmg:24, sc:50 };
  if (t > 22 && r < 0.35) return { key:"runner", r:0.75, speed:11.5, hp:12+t*0.4, dmg:6, sc:15 };
  return { key:"grunt", r:1.1, speed:5.4, hp:22+t*0.7, dmg:9, sc:10 };
}
function spawnEnemy() {
  const a = rand(0, 6.28), d = 44;
  const x = player.x + Math.cos(a) * d, z = player.z + Math.sin(a) * d;
  const t = enemyType();
  const mesh = new THREE.Mesh(GEO[t.key], MAT[t.key]);
  mesh.position.set(x, t.r, z); mesh.castShadow = true; scene.add(mesh);
  const bar = makeHpBar(clamp(t.r * 2.2, 1.6, 4));
  enemies.push({ x, z, r:t.r, speed:t.speed, hp:t.hp, maxHp:t.hp, dmg:t.dmg, sc:t.sc, flash:0, kx:0, kz:0, spin:rand(-2,2), mesh, bar });
}
function spawnBoss() {
  const a = rand(0, 6.28), d = 46;
  const x = player.x + Math.cos(a) * d, z = player.z + Math.sin(a) * d;
  const r = 5, hp = 3500 + gameTime * 8;
  const mesh = new THREE.Mesh(new THREE.DodecahedronGeometry(r, 0),
    new THREE.MeshStandardMaterial({ color: 0x3a0d10, emissive: 0xff2a2a, emissiveIntensity: 0.7, flatShading: true }));
  mesh.position.set(x, r, z); mesh.castShadow = true; scene.add(mesh);
  const bar = makeHpBar(6);
  boss = { x, z, r, speed: 4.6, hp, maxHp: hp, dmg: 45, sc: 1500, flash: 0, kx: 0, kz: 0, spin: 0.6, boss: true, atkT: 2, mesh, bar, mat: mesh.material };
  enemies.push(boss);
  toast("👹 LE BOSS ARRIVE !"); beep(70, 0.6, "sawtooth", 0.08); shake = 1.2;
}
const ebGeo = new THREE.IcosahedronGeometry(0.5, 0);
const ebMat = new THREE.MeshBasicMaterial({ color: 0xff3030 });
function spawnEnemyBullet(x, z, ang, speed, dmg) {
  const m = new THREE.Mesh(ebGeo, ebMat); m.position.set(x, BULLET_Y, z); scene.add(m);
  enemyBullets.push({ x, z, vx: Math.cos(ang) * speed, vz: Math.sin(ang) * speed, life: 4, dmg, mesh: m });
}
function dropRandom(x, z) {
  const table = [["weapon", WEAPON_KEYS], ["item", ITEM_KEYS], ["buff", BUFF_POOL]];
  const [kind, keys] = pick(table); dropPickup(x, z, kind, pick(keys));
}
function keyOf(weapon) { return WEAPON_KEYS.find(k => BASE_WEAPONS[k].name === weapon.name); }
function rollDrop(x, z) {
  const r = Math.random();
  if (r < 0.05) dropPickup(x, z, "weapon", pick(WEAPON_KEYS));   // n'importe quelle arme (dont l'actuelle -> lvl up)
  else if (r < 0.13) dropPickup(x, z, "item", pick(ITEM_KEYS));
  else if (r < 0.30) dropPickup(x, z, "buff", pick(BUFF_POOL));
}
// Construit la boule de butin (globe + halo + icône) à (x,z). Renvoie { g, ico }.
function makePickupMesh(x, z, kind, key) {
  let col, ico;
  if (kind === "weapon") { col = BASE_WEAPONS[key].col; ico = BASE_WEAPONS[key].ico; }
  else if (kind === "item") { col = ITEMS[key].col; ico = ITEMS[key].ico; }
  else { col = BUFFS[key].col; ico = BUFFS[key].ico; }
  const g = new THREE.Group();
  const globe = new THREE.Mesh(new THREE.SphereGeometry(1.05, 18, 14),
    new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.32 }));
  const halo = new THREE.Mesh(new THREE.SphereGeometry(1.35, 16, 12),
    new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.12 }));
  g.add(globe); g.add(halo);
  g.add(makeIconSprite(ico)); // l'icône flotte au centre de la boule
  g.position.set(x, 1.4, z); scene.add(g);
  return { g, ico };
}
// SOLO : crée un butin local (le serveur s'en charge en co-op, voir netSync).
function dropPickup(x, z, kind, key) {
  const { g, ico } = makePickupMesh(x, z, kind, key);
  pickups.push({ x, z, kind, key, ico, r: 1.4, bob: rand(0, 6.28), mesh: g });
}
// Applique l'effet d'un butin au joueur local. Renvoie false si un OBJET n'a pas
// pu être pris (inventaire plein) -> le pickup doit rester au sol.
function applyPickupEffect(kind, key) {
  if (kind === "weapon") {
    const lv = (player.weaponLvl[key] || 0) + 1; player.weaponLvl[key] = lv;
    player.weapon = computeWeapon(key, lv);
    toast(`${player.weapon.ico} ${player.weapon.name} Nv.${lv}`); beep(900, 0.1, "square", 0.04);
    return true;
  }
  if (kind === "buff") { BUFFS[key].apply(player); beep(1000, 0.08, "sine", 0.03); return true; }
  if (!addItem(key)) return false;
  beep(760, 0.08, "square", 0.03); return true;
}
const invFull = () => player.inv.indexOf(null) === -1;

// ============================================================
//  PARTICULES
// ============================================================
function spawnParticles(x, z, col, n) {
  const mat = new THREE.MeshBasicMaterial({ color: col });
  const gy = terrainHeight(x, z);                    // éclosion au niveau du sol local
  for (let i = 0; i < n; i++) {
    const a = rand(0, 6.28), s = rand(4, 16);
    const m = new THREE.Mesh(GEO.particle, mat);
    m.position.set(x, gy + 1, z); scene.add(m);
    particles.push({ x, z, y: gy + 1, floor: gy, vx:Math.cos(a)*s, vz:Math.sin(a)*s, vy:rand(4,10), life:rand(0.3,0.6), mesh:m });
  }
}

// ============================================================
//  BOUCLE
// ============================================================
let lastT = performance.now();
function loop(now) {
  const dt = Math.min(0.05, (now - lastT) / 1000); lastT = now;
  if (state === "play") update(dt);
  if (mixer) mixer.update(dt);
  if (charReady) { const t = (player && player.moving && state === "play") ? 1 : 0; actRun.weight += (t - actRun.weight) * Math.min(1, dt * 10); actIdle.weight = 1 - actRun.weight; }
  for (const av of remoteAvatars.values()) if (av.mixer) av.mixer.update(dt);   // anim des joueurs distants
  updateRemoteShots(dt);   // projectiles cosmétiques des autres joueurs
  syncMeshes();
  netSync(now);
  // caméra suit le joueur (+ petit shake)
  const px = player ? player.x : 0, pz = player ? player.z : 0;
  const ph = player && player.gy != null ? player.gy : terrainHeight(px, pz);   // altitude lissée
  water.position.set(px, WATER_LEVEL, pz);   // nappe d'eau qui suit le joueur
  updateChunks(px, pz);             // génère/décharge le monde autour de lui
  const sx = shake > 0 ? rand(-shake, shake) : 0, sz = shake > 0 ? rand(-shake, shake) : 0;
  camera.position.set(px + CAM_OFF.x + sx, CAM_OFF.y + ph, pz + CAM_OFF.z + sz);
  camera.lookAt(px, ph, pz);
  sun.position.set(px + 40, 80 + ph, pz + 20); sun.target.position.set(px, ph, pz);
  updateAimPreview();   // feedforward : prévisualise l'objet armé au sol
  if (shake > 0) shake -= dt * 2;
  composer.render();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// ============================================================
//  MULTIJOUEUR — présence : envoi de ma position + avatars distants
// ============================================================
const remoteAvatars = new Map();   // sessionId -> THREE.Group
let netSendT = 0;
const NET_HZ = 20;                  // fréquence d'envoi de la position (= tick serveur)
// Interpolation par snapshots : on rend les joueurs distants avec ce léger retard
// fixe et on interpole entre les 2 positions reçues qui encadrent l'instant de rendu.
// Résultat fluide quel que soit le débit réseau (~2 intervalles d'envoi de marge).
const REMOTE_INTERP_DELAY = 100;   // ms
let wantDensity = 1, sentDensity = -1;   // densité de horde voulue (outil de test)

// lerp d'angle par le plus court chemin (gère le passage -π / +π)
function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

// échantillonne le buffer de snapshots {t,x,z,face} à l'instant renderT.
// Renvoie la position/angle interpolés + un flag `moving` (pour l'anim course/idle).
// Pas d'extrapolation : si renderT dépasse le dernier snapshot (paquet en retard),
// on fige sur le dernier connu plutôt que de sur-anticiper.
function sampleSnapshots(buf, renderT) {
  const n = buf.length;
  if (n === 0) return null;
  if (n === 1 || renderT <= buf[0].t) return { x: buf[0].x, z: buf[0].z, face: buf[0].face, moving: false };
  const last = buf[n - 1];
  if (renderT >= last.t) return { x: last.x, z: last.z, face: last.face, moving: false };
  for (let i = 0; i < n - 1; i++) {
    const s0 = buf[i], s1 = buf[i + 1];
    if (renderT >= s0.t && renderT <= s1.t) {
      const u = (renderT - s0.t) / ((s1.t - s0.t) || 1);
      return {
        x: s0.x + (s1.x - s0.x) * u,
        z: s0.z + (s1.z - s0.z) * u,
        face: lerpAngle(s0.face, s1.face, u),
        moving: Math.hypot(s1.x - s0.x, s1.z - s0.z) > 0.05,
      };
    }
  }
  return { x: last.x, z: last.z, face: last.face, moving: false };
}

// fallback low-poly : le temps que Barbarian.glb charge (ou s'il échoue)
function makeRemotePrimitive() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.55, 1.1, 4, 8),
    new THREE.MeshStandardMaterial({ color: 0x4fd0ff, emissive: 0x1c7ba0, emissiveIntensity: 0.45, flatShading: true })
  );
  body.position.y = 1.15; body.castShadow = true;
  const head = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.42, 0),
    new THREE.MeshStandardMaterial({ color: 0xbfefff, flatShading: true })
  );
  head.position.y = 2.05;
  g.add(body, head);
  return g;
}

// avatar d'un joueur distant : clone du VRAI personnage (animé) si le modèle est
// chargé, sinon primitive. Renvoie un objet { group, mixer, actIdle, actRun, isModel }.
function makeRemoteAvatar(px, pz) {
  let group, mixer = null, actIdle = null, actRun = null, isModel = false;
  if (charProto) {
    group = SkeletonUtils.clone(charProto);   // clone correct des skinned meshes (skeleton propre)
    group.traverse(o => { if (o.isMesh) o.castShadow = true; });
    mixer = new THREE.AnimationMixer(group);
    const idleClip = findClip(charClips, "idle") || charClips[0];
    if (idleClip) { actIdle = mixer.clipAction(idleClip); actIdle.play(); actIdle.weight = 1; }
    const runClip = findClip(charClips, "running", "run", "walk", "sprint", "jog") || idleClip;
    if (runClip) { actRun = mixer.clipAction(runClip); actRun.play(); actRun.weight = 0; }
    isModel = true;
  } else {
    group = makeRemotePrimitive();
  }
  group.position.set(px, 0, pz);
  scene.add(group);
  return { group, mixer, actIdle, actRun, isModel };
}

// ---------- projectiles COSMÉTIQUES des autres joueurs ----------
// Reçus via le relais serveur "shot". Ils ne font AUCUN dégât ici : le tireur
// gère ses propres impacts (et signale au serveur), donc pas de double dégât.
const remoteShots = [];
function spawnRemoteShot(d) {
  if (!d || state !== "play") return;
  if (d.k === "bullet") {
    const col = d.col ?? 0xffe98a, sp = d.sp ?? 42, life = d.life ?? 1.1;
    for (const a of (d.angs || [])) {
      const m = new THREE.Mesh(GEO.bullet, bulletMat(col));
      m.position.set(d.x, BULLET_Y, d.z); scene.add(m);
      remoteShots.push({ type:"bullet", x:d.x, z:d.z, vx:Math.cos(a)*sp, vz:Math.sin(a)*sp, life, mesh:m });
    }
  } else if (d.k === "bombe") {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1, 0.4, 6, 24), new THREE.MeshBasicMaterial({ color: 0xff9a4a }));
    ring.rotation.x = -Math.PI / 2; ring.position.set(d.x, terrainHeight(d.x, d.z) + 0.5, d.z); scene.add(ring);
    remoteShots.push({ type:"boom", x:d.x, z:d.z, life:0.4, max:0.4, radius:11, mesh:ring });
    spawnParticles(d.x, d.z, 0xff9a4a, 22);
  } else if (d.k === "laser") {
    const m = new THREE.Mesh(new THREE.BoxGeometry(100, 0.7, 0.7), new THREE.MeshBasicMaterial({ color: 0xff4ad0 }));
    scene.add(m);
    remoteShots.push({ type:"laser", x:d.x, z:d.z, ang:d.a || 0, len:100, life:0.9, max:0.9, mesh:m });
  } else if (d.k === "boomerang") {
    const m = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.25, 0.5),
      new THREE.MeshStandardMaterial({ color: 0xb98cff, emissive: 0xb98cff, emissiveIntensity: 1.7, flatShading: true }));
    m.position.set(d.x, BULLET_Y, d.z); scene.add(m);
    const a = d.a || 0;
    remoteShots.push({ type:"boomerang", x:d.x, z:d.z, vx:Math.cos(a)*42, vz:Math.sin(a)*42, life:1.4, mesh:m });
  }
}
function updateRemoteShots(dt) {
  for (let i = remoteShots.length - 1; i >= 0; i--) {
    const s = remoteShots[i];
    s.life -= dt;
    if (s.type === "bullet" || s.type === "boomerang") {
      s.x += s.vx * dt; s.z += s.vz * dt;
      s.mesh.position.set(s.x, terrainHeight(s.x, s.z) + BULLET_Y, s.z);
      if (s.type === "boomerang") s.mesh.rotation.y += 0.7;
    } else if (s.type === "boom") {
      const k = 1 - s.life / s.max;
      s.mesh.scale.setScalar(0.5 + s.radius * k);
      s.mesh.material.transparent = true; s.mesh.material.opacity = Math.max(0, s.life / s.max);
    } else if (s.type === "laser") {
      { const lx = s.x + Math.cos(s.ang) * s.len / 2, lz = s.z + Math.sin(s.ang) * s.len / 2;
        s.mesh.position.set(lx, terrainHeight(s.x, s.z) + 1.1, lz); }
      s.mesh.rotation.y = -s.ang;
      const t = s.life / s.max; s.mesh.scale.set(1, 0.4 + t, 0.4 + t);
    }
    if (s.life <= 0) { scene.remove(s.mesh); remoteShots.splice(i, 1); }
  }
}
onShot(spawnRemoteShot);   // enregistre le rendu des tirs distants

// --- co-op : horde autoritaire serveur reflétée dans le tableau `enemies` ---
const inCoop = () => !!getRoom();
const netEnemies = new Map();               // serverId -> ennemi miroir (aussi dans `enemies`)
const ENEMY_DMG = { grunt: 9, runner: 6, brute: 24, boss: 45 };

function buildNetEnemy(id, se) {
  const isBoss = se.kind === "boss";
  let mesh, mat;
  if (isBoss) {
    mat = new THREE.MeshStandardMaterial({ color: 0x3a0d10, emissive: 0xff2a2a, emissiveIntensity: 0.7, flatShading: true });
    mesh = new THREE.Mesh(new THREE.DodecahedronGeometry(se.r, 0), mat);
    toast("👹 LE BOSS ARRIVE !"); shake = 1.0; beep(70, 0.6, "sawtooth", 0.08);
  } else {
    const kind = se.kind in GEO ? se.kind : "grunt";
    mat = MAT[kind];
    mesh = new THREE.Mesh(GEO[kind], mat);
  }
  mesh.castShadow = true; mesh.position.set(se.x, se.r, se.z); scene.add(mesh);
  const bar = makeHpBar(clamp(se.r * 2.2, 1.6, isBoss ? 6 : 4));
  const e = {
    id, net: true, kind: se.kind, x: se.x, z: se.z, r: se.r, hp: se.hp, maxHp: se.maxHp,
    dmg: ENEMY_DMG[se.kind] || 9, sc: 0, speed: 0, flash: 0, kx: 0, kz: 0,
    spin: rand(-2, 2), mesh, bar, mat,
  };
  enemies.push(e); netEnemies.set(id, e);
  return e;
}
function removeNetEnemy(id) {
  const e = netEnemies.get(id); if (!e) return;
  scene.remove(e.mesh); scene.remove(e.bar);
  const i = enemies.indexOf(e); if (i >= 0) enemies.splice(i, 1);
  netEnemies.delete(id);
}

// --- co-op : butin autoritaire serveur reflété dans le tableau `pickups` ---
const netPickups = new Map();               // serverId -> pickup miroir (aussi dans `pickups`)
function buildNetPickup(id, sp) {
  const { g, ico } = makePickupMesh(sp.x, sp.z, sp.kind, sp.key);
  const p = { id, net: true, x: sp.x, z: sp.z, kind: sp.kind, key: sp.key, ico, r: 1.4, bob: rand(0, 6.28), mesh: g, claimed: false };
  pickups.push(p); netPickups.set(id, p);
  return p;
}
function removeNetPickup(id) {
  const p = netPickups.get(id); if (!p) return;
  scene.remove(p.mesh);
  const i = pickups.indexOf(p); if (i >= 0) pickups.splice(i, 1);
  netPickups.delete(id);
}
// Le serveur a validé notre ramassage -> on applique l'effet (le pickup disparaît
// pour tous via l'état répliqué, géré par removeNetPickup au prochain sync).
onGrabbed(d => { if (player) applyPickupEffect(d.kind, d.key); });
// point de dégât unique : en co-op on signale au serveur (autoritaire) ; sinon local.
function damageEnemy(e, dmg) {
  e.hp -= dmg;                 // feedback instantané (barre) ; le serveur corrige au sync
  if (e.net) sendHit(e.id, dmg);
}

// --- flèches de bord pointant vers les coéquipiers hors champ ---
let arrowLayer = null;
const teamArrows = new Map();            // sessionId -> élément DOM
function ensureArrowLayer() {
  if (arrowLayer) return arrowLayer;
  arrowLayer = document.createElement("div");
  arrowLayer.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:6;";
  (document.getElementById("hud") || document.body).appendChild(arrowLayer);
  return arrowLayer;
}
function makeArrow() {
  const el = document.createElement("div");
  el.style.cssText =
    "position:absolute;left:0;top:0;will-change:transform;transition:opacity .15s;" +
    "font-size:26px;font-weight:900;color:#4fd0ff;text-shadow:0 0 8px #1c7ba0,0 2px 4px #000;";
  el.textContent = "➤";
  ensureArrowLayer().appendChild(el);
  return el;
}
const _v = new THREE.Vector3();
function updateTeammateArrows(room, me) {
  if (state !== "play") { for (const [, el] of teamArrows) el.style.opacity = "0"; return; }
  const seen = new Set();
  const margin = 48;
  room.state.players.forEach((p, id) => {
    if (id === me) return;
    seen.add(id);
    // on prend la position lissée de l'avatar si dispo (plus stable)
    const av = remoteAvatars.get(id);
    _v.set(av ? av.group.position.x : p.x, 1.2, av ? av.group.position.z : p.z);
    _v.project(camera);                  // -> NDC ; z>1 = derrière la caméra
    let x = _v.x, y = _v.y;
    const behind = _v.z > 1;
    if (behind) { x = -x; y = -y; }
    const onScreen = !behind && Math.abs(x) <= 1 && Math.abs(y) <= 1;
    let el = teamArrows.get(id);
    if (onScreen) { if (el) el.style.opacity = "0"; return; }   // à l'écran -> pas de flèche
    if (!el) { el = makeArrow(); teamArrows.set(id, el); }
    el.style.opacity = "0.95";
    // ramène le point sur le bord de l'écran (avec marge)
    const m = Math.max(Math.abs(x), Math.abs(y)) || 1;
    const ex = x / m, ey = y / m;
    const sx = clamp((ex * 0.5 + 0.5) * W, margin, W - margin);
    const sy = clamp((-ey * 0.5 + 0.5) * H, margin, H - margin);
    const ang = Math.atan2(-ey, ex) * 180 / Math.PI;            // ➤ pointe vers +x
    el.style.transform = `translate(-50%,-50%) translate(${sx}px,${sy}px) rotate(${ang}deg)`;
  });
  for (const [id, el] of teamArrows) {
    if (!seen.has(id)) { el.remove(); teamArrows.delete(id); }
  }
}

function netSync(now) {
  const room = getRoom();
  if (!room || !room.state) return;

  // 0) pousser la densité de test au serveur si elle a changé
  if (wantDensity !== sentDensity) { sendDensity(wantDensity); sentDensity = wantDensity; }

  // 1) envoyer MA position (throttle à NET_HZ) — aim = tir, face = corps
  if (player && state === "play" && now - netSendT > 1000 / NET_HZ) {
    netSendT = now;
    sendPos(player.x, player.z, (player.aim ?? player.face) || 0, player.face || 0);
  }

  // 2) refléter les joueurs distants (interpolation simple)
  const me = getSessionId();
  const seen = new Set();
  room.state.players.forEach((p, id) => {
    if (id === me) return;
    seen.add(id);
    let av = remoteAvatars.get(id);
    if (!av) { av = makeRemoteAvatar(p.x, p.z); remoteAvatars.set(id, av); }
    // upgrade primitive -> vrai modèle dès que Barbarian.glb est chargé
    else if (!av.isModel && charProto) {
      const oldBuf = av.buf;
      scene.remove(av.group);
      av = makeRemoteAvatar(av.group.position.x, av.group.position.z);
      av.buf = oldBuf;   // on garde l'historique d'interpolation (pas de saut)
      remoteAvatars.set(id, av);
    }
    const g = av.group;

    // bufferiser chaque NOUVELLE position serveur avec un timestamp local
    if (!av.buf) av.buf = [];
    const buf = av.buf;
    const face = p.face || 0;
    const prev = buf[buf.length - 1];
    if (!prev || Math.abs(p.x - prev.x) > 1e-3 || Math.abs(p.z - prev.z) > 1e-3 || Math.abs(face - prev.face) > 1e-3) {
      buf.push({ t: now, x: p.x, z: p.z, face });
      // purge l'historique devenu inutile (au-delà du délai d'interpolation + marge)
      while (buf.length > 2 && buf[1].t < now - (REMOTE_INTERP_DELAY + 250)) buf.shift();
    }

    // rendu interpolé à (now - délai) entre les 2 snapshots qui l'encadrent
    const s = sampleSnapshots(buf, now - REMOTE_INTERP_DELAY);
    if (s) {
      g.position.x = s.x;
      g.position.y = terrainHeight(s.x, s.z);   // posé sur le relief (recalculé en local)
      g.position.z = s.z;
      g.rotation.y = s.face + FACE_OFFSET;   // orientation du CORPS via `face`
    }
    g.visible = (state === "play");
    // blend course/idle : basé sur le mouvement réel entre les snapshots interpolés
    if (av.actRun) {
      const t = s && s.moving ? 1 : 0;
      av.actRun.weight += (t - av.actRun.weight) * 0.2;
      if (av.actIdle) av.actIdle.weight = 1 - av.actRun.weight;
    }
  });
  for (const [id, av] of remoteAvatars) {
    if (!seen.has(id)) { scene.remove(av.group); remoteAvatars.delete(id); }
  }

  // 3) refléter la horde autoritaire (positions serveur + interpolation légère)
  const seenE = new Set();
  room.state.enemies.forEach((se, id) => {
    seenE.add(id);
    let e = netEnemies.get(id) || buildNetEnemy(id, se);
    e.x += (se.x - e.x) * 0.4;
    e.z += (se.z - e.z) * 0.4;
    e.hp = se.hp; e.maxHp = se.maxHp;
  });
  for (const id of netEnemies.keys()) if (!seenE.has(id)) removeNetEnemy(id);

  // 3bis) refléter le butin autoritaire (spawn/retrait pilotés par le serveur)
  const seenP = new Set();
  room.state.pickups.forEach((sp, id) => {
    seenP.add(id);
    if (!netPickups.has(id)) buildNetPickup(id, sp);
  });
  for (const id of netPickups.keys()) if (!seenP.has(id)) removeNetPickup(id);

  // 4) score & kills partagés (autoritaires)
  score = room.state.score;
  kills = room.state.kills;

  // 5) flèches vers les coéquipiers hors champ
  updateTeammateArrows(room, me);
}

function update(dt) {
  gameTime += dt; score += dt * 2;
  if (player.iframe > 0) player.iframe -= dt;
  if (player.shield > 0) player.shield -= dt;
  if (player.speedBuff > 0) player.speedBuff -= dt;
  if (player.frenzy > 0) player.frenzy -= dt;

  // déplacement relatif caméra
  const fwd = new THREE.Vector3(); camera.getWorldDirection(fwd); fwd.y = 0; fwd.normalize();
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0); right.y = 0; right.normalize();
  let mx = 0, mz = 0;
  if (keys["KeyW"] || keys["ArrowUp"]) { mx += fwd.x; mz += fwd.z; }
  if (keys["KeyS"] || keys["ArrowDown"]) { mx -= fwd.x; mz -= fwd.z; }
  if (keys["KeyD"] || keys["ArrowRight"]) { mx += right.x; mz += right.z; }
  if (keys["KeyA"] || keys["ArrowLeft"]) { mx -= right.x; mz -= right.z; }
  // tactile / clic : si pas de clavier, on se dirige vers le point tapé
  if (mx !== 0 || mz !== 0) player.moveTarget = null;   // le clavier annule la cible
  else if (player.moveTarget) {
    const ddx = player.moveTarget.x - player.x, ddz = player.moveTarget.z - player.z, dl = Math.hypot(ddx, ddz);
    if (dl > 0.8) { mx = ddx; mz = ddz; } else player.moveTarget = null;   // arrivé
  }
  const ml = Math.hypot(mx, mz);
  player.moving = ml > 0.001;
  if (ml > 0) { mx /= ml; mz /= ml; player.face = Math.atan2(mx, mz); }
  { const nx = player.x + mx * player.speed * dt, nz = player.z + mz * player.speed * dt;
    const mv = moveWithCliffs(player.x, player.z, nx, nz); player.x = mv.x; player.z = mv.z; }
  // hauteur lissée (monte/descend les marches en douceur -> pas de saut sec)
  { const th = terrainHeight(player.x, player.z);
    player.gy = player.gy == null ? th : player.gy + (th - player.gy) * Math.min(1, dt * 9); }

  // spawn : ennemis normaux jusqu'au boss ; passé le timer, plus de spawn -> boss quand tout est nettoyé
  // en co-op : la horde (et le boss) sont pilotés par le serveur -> on désactive le spawn local
  if (!boss && !inCoop()) {
    if (gameTime < nextBossTime) {
      spawnTimer -= dt;
      const every = Math.max(0.16, 1.1 - gameTime * 0.013);
      if (spawnTimer <= 0) { spawnEnemy(); spawnTimer = every; }
    } else if (enemies.length === 0) {
      spawnBoss();
    }
  }

  // visée : ennemi le plus proche (INDÉPENDANT de la direction de course)
  let best = null, bd = 1e12;
  for (const e of enemies) { const d = dist2(player.x, player.z, e.x, e.z); if (d < bd) { bd = d; best = e; } }
  player.hasAim = !!(best && bd < 34 * 34);
  if (player.hasAim) player.aim = Math.atan2(best.z - player.z, best.x - player.x);

  // tir auto : les boules partent du COMPAGNON, vers la cible
  player.fireT -= dt;
  const w = player.weapon;
  const interval = w.fireInt * (player.frenzy > 0 ? 0.5 : 1);
  if (player.fireT <= 0 && player.hasAim) {
    const px = petMesh ? petMesh.position.x : player.x, pz = petMesh ? petMesh.position.z : player.z;
    const angs = [];
    for (let i = 0; i < w.count; i++) {
      const off = (i - (w.count - 1) / 2) * w.spread;
      const a = player.aim + off + rand(-w.spread * 0.15, w.spread * 0.15);
      angs.push(a);
      const m = new THREE.Mesh(GEO.bullet, bulletMat(w.col));
      m.position.set(px, BULLET_Y, pz); scene.add(m);
      bullets.push({ x:px, z:pz, vx:Math.cos(a)*w.projSpeed, vz:Math.sin(a)*w.projSpeed, life:w.life || 1.1, dmg:w.dmg, pierce:w.pierce, mesh:m });
    }
    // co-op : les autres joueurs voient mes tirs (cosmétique)
    if (inCoop()) sendShot({ k:"bullet", x:px, z:pz, angs, sp:w.projSpeed, col:w.col, life:w.life || 1.1 });
    player.fireT = interval; beep(660, 0.04, "square", 0.015);
  }

  // balles
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.x += b.vx * dt; b.z += b.vz * dt; b.life -= dt;
    if (b.life <= 0) { scene.remove(b.mesh); bullets.splice(i, 1); continue; }
    for (const e of enemies) {
      const rr = 0.32 + e.r;
      if (dist2(b.x, b.z, e.x, e.z) < rr * rr) {
        damageEnemy(e, b.dmg); e.flash = 0.08; e.kx += b.vx * 0.02; e.kz += b.vz * 0.02;
        spawnParticles(b.x, b.z, 0xffffff, 2);
        if (b.pierce > 0) b.pierce--; else { scene.remove(b.mesh); bullets.splice(i, 1); }
        break;
      }
    }
  }

  // effets
  for (let i = effects.length - 1; i >= 0; i--) {
    const f = effects[i];
    if (f.type === "boomerang") {
      f.x += f.vx * dt; f.z += f.vz * dt; f.life -= dt;
      for (const e of enemies) {
        if (f.hit.has(e)) continue;
        if (dist2(f.x, f.z, e.x, e.z) < (f.r + e.r) ** 2) {
          damageEnemy(e, f.dmg); e.flash = 0.12; f.hit.add(e); f.bounces--;
          spawnParticles(f.x, f.z, 0xb98cff, 6);
          // ricochet : on repart vers l'ennemi le plus proche pas encore touché
          let nx = null, nd = 30 * 30;
          for (const o of enemies) { if (f.hit.has(o)) continue; const d = dist2(f.x, f.z, o.x, o.z); if (d < nd) { nd = d; nx = o; } }
          if (nx) { const a = Math.atan2(nx.z - f.z, nx.x - f.x); f.vx = Math.cos(a) * f.speed; f.vz = Math.sin(a) * f.speed; }
          break;
        }
      }
      if (f.bounces <= 0 || f.life <= 0) { spawnParticles(f.x, f.z, 0xb98cff, 10); scene.remove(f.mesh); effects.splice(i, 1); }
    } else if (f.type === "laser") {
      f.life -= dt;
      laserDamage(player.x, player.z, player.x + Math.cos(f.ang) * 100, player.z + Math.sin(f.ang) * 100, f.dps * dt, 1.6);
      if (f.life <= 0) { scene.remove(f.mesh); effects.splice(i, 1); }
    } else if (f.type === "boom") {
      f.life -= dt; if (f.life <= 0) { scene.remove(f.mesh); effects.splice(i, 1); }
    }
  }

  // ennemis
  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i];
    const a = Math.atan2(player.z - e.z, player.x - e.x);
    // en co-op, la position vient du serveur (voir netSync) -> pas de déplacement local
    if (!e.net) {
      const nx = e.x + Math.cos(a) * e.speed * dt + e.kx, nz = e.z + Math.sin(a) * e.speed * dt + e.kz;
      const mv = moveWithCliffs(e.x, e.z, nx, nz); e.x = mv.x; e.z = mv.z; e.kx *= 0.86; e.kz *= 0.86;
    }
    if (e.flash > 0) e.flash -= dt;
    const rr = e.r + player.r;
    if (dist2(e.x, e.z, player.x, player.z) < rr * rr && player.iframe <= 0) {
      if (player.shield > 0) damageEnemy(e, 99999);
      else { player.hp -= e.dmg; player.iframe = 0.6; shake = 0.5; beep(120,0.15,"sawtooth",0.05); spawnParticles(player.x, player.z, 0xff5555, 8); if (player.hp <= 0) { die(); return; } }
    }
    if (e.hp <= 0 && !e.net) {
      kills++; score += e.sc;
      if (e.boss) {
        boss = null; nextBossTime = gameTime + bossDelay; toast("💀 BOSS VAINCU !");
        spawnParticles(e.x, e.z, 0xff3030, 60); shake = 1.0; beep(60, 0.8, "sawtooth", 0.08);
        for (let k = 0; k < 6; k++) { const aa = rand(0, 6.28); dropRandom(e.x + Math.cos(aa) * 4, e.z + Math.sin(aa) * 4); }
      } else { spawnParticles(e.x, e.z, 0xaa88ff, 10); rollDrop(e.x, e.z); beep(200, 0.05, "square", 0.012); }
      scene.remove(e.mesh); scene.remove(e.bar); enemies.splice(i, 1);
    }
  }

  // pickups
  for (let i = pickups.length - 1; i >= 0; i--) {
    const p = pickups[i];
    const rr = p.r + player.r + 0.6;
    if (dist2(p.x, p.z, player.x, player.z) < rr * rr) {
      if (p.net) {
        // butin autoritaire : on DEMANDE au serveur, sans appliquer localement.
        // Le serveur tranche (1er arrivé) et retire le pickup pour tous.
        if (p.claimed) continue;                          // déjà demandé -> pas de spam
        if (p.kind === "item" && invFull()) continue;     // inventaire plein -> on le laisse
        p.claimed = true; sendGrab(p.id);
        continue;
      }
      if (!applyPickupEffect(p.kind, p.key)) continue;    // solo : objet + inventaire plein -> reste au sol
      scene.remove(p.mesh); pickups.splice(i, 1);
    }
  }

  // particules
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx * dt; p.z += p.vz * dt; p.y += p.vy * dt; p.vy -= 30 * dt; p.vx *= 0.92; p.vz *= 0.92; p.life -= dt;
    if (p.life <= 0 || p.y < (p.floor ?? 0)) { scene.remove(p.mesh); particles.splice(i, 1); }
  }

  // BOSS : barrage de projectiles vers le joueur
  if (boss && boss.hp > 0) {
    boss.atkT -= dt;
    if (boss.atkT <= 0) {
      boss.atkT = 1.6;
      const base = Math.atan2(player.z - boss.z, player.x - boss.x);
      for (let i = 0; i < 11; i++) spawnEnemyBullet(boss.x, boss.z, base + (i - 5) * 0.15, 30, 15);
      beep(150, 0.25, "sawtooth", 0.05);
    }
  }
  // projectiles ennemis
  for (let i = enemyBullets.length - 1; i >= 0; i--) {
    const b = enemyBullets[i];
    b.x += b.vx * dt; b.z += b.vz * dt; b.life -= dt;
    if (b.life <= 0) { scene.remove(b.mesh); enemyBullets.splice(i, 1); continue; }
    const rr = 0.5 + player.r;
    if (dist2(b.x, b.z, player.x, player.z) < rr * rr) {
      if (player.shield <= 0 && player.iframe <= 0) {
        player.hp -= b.dmg; player.iframe = 0.5; shake = 0.4; spawnParticles(player.x, player.z, 0xff5555, 8);
        scene.remove(b.mesh); enemyBullets.splice(i, 1);
        if (player.hp <= 0) { die(); return; }
        continue;
      }
      scene.remove(b.mesh); enemyBullets.splice(i, 1); // bloqué (bouclier / i-frames)
    }
  }

  updateHUD();
}

// ============================================================
//  SYNC MESHES (état logique -> positions 3D)
// ============================================================
function syncMeshes() {
  if (!player) return;
  const ph = player.gy != null ? player.gy : terrainHeight(player.x, player.z);   // altitude lissée
  playerMesh.position.set(player.x, ph, player.z);
  playerMesh.rotation.y = player.face + FACE_OFFSET;
  playerMesh.visible = !(player.iframe > 0 && Math.floor(gameTime * 20) % 2);
  // bouclier : bulle translucide autour du perso quand actif
  shieldMesh.visible = (state === "play") && player.shield > 0;
  if (shieldMesh.visible) {
    shieldMesh.position.set(player.x, ph + 1.2, player.z);
    shieldMesh.scale.setScalar(1 + Math.sin(gameTime * 8) * 0.06);
  }
  // compagnon volant : au-dessus de la tête, bob + anneau tournant + visée
  if (petMesh) {
    petMesh.position.set(player.x, ph + 4.0 + Math.sin(gameTime * 2.5) * 0.25, player.z);
    petMesh.userData.ring.rotation.z += 0.05;
    if (player.hasAim) petMesh.rotation.y = Math.PI / 2 - player.aim;
  }
  for (const e of enemies) {
    const th = terrainHeight(e.x, e.z);                 // hauteur lissée : monte/descend les marches
    e._gy = e._gy == null ? th : e._gy + (th - e._gy) * 0.25;
    const eh = e._gy;
    e.mesh.position.set(e.x, eh + e.r, e.z); e.mesh.rotation.y += e.spin * 0.02;
    e.mesh.material = e.flash > 0 ? whiteMat : (e.mat || MAT[matKey(e)]);
    // barre de vie : visible dès qu'on l'a touché, billboard face caméra
    const ratio = clamp(e.hp / e.maxHp, 0, 1);
    e.bar.visible = e.hp < e.maxHp;
    if (e.bar.visible) {
      e.bar.position.set(e.x, eh + e.r * 2 + 1.2, e.z);
      e.bar.quaternion.copy(camera.quaternion);
      const f = e.bar.userData.fill, w = e.bar.userData.w;
      f.scale.x = ratio; f.position.x = -w * (1 - ratio) / 2;
      f.material.color.setHSL(0.33 * ratio, 0.85, 0.5);
    }
  }
  for (const b of bullets) b.mesh.position.set(b.x, terrainHeight(b.x, b.z) + BULLET_Y, b.z);
  for (const b of enemyBullets) b.mesh.position.set(b.x, terrainHeight(b.x, b.z) + BULLET_Y, b.z);
  for (const p of pickups) { p.mesh.position.set(p.x, terrainHeight(p.x, p.z) + 1.2 + Math.sin(gameTime * 3 + p.bob) * 0.25, p.z); p.mesh.rotation.y += 0.03; }
  for (const p of particles) p.mesh.position.set(p.x, p.y, p.z);
  for (const f of effects) {
    if (f.type === "boomerang") { f.mesh.position.set(f.x, terrainHeight(f.x, f.z) + BULLET_Y, f.z); f.mesh.rotation.y += 0.7; }
    else if (f.type === "boom") { const k = 1 - f.life / f.max; f.mesh.scale.setScalar(0.5 + f.radius * k); f.mesh.material.opacity = f.life / f.max; f.mesh.material.transparent = true; }
    else if (f.type === "laser") {
      const lx = player.x + Math.cos(f.ang) * f.len / 2, lz = player.z + Math.sin(f.ang) * f.len / 2;
      f.mesh.position.set(lx, ph + 1.1, lz);
      f.mesh.rotation.y = -f.ang;
      const s = f.life / f.max; f.mesh.scale.set(1, 0.4 + s, 0.4 + s);
    }
  }
}
const whiteMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
function matKey(e) { return e.r > 1.5 ? "brute" : e.r < 0.9 ? "runner" : "grunt"; }

// ============================================================
//  HUD
// ============================================================
const $ = id => document.getElementById(id);
let toastMsg = "", toastT = 0;
function toast(m) { toastMsg = m; toastT = 1.6; }
function updateHUD() {
  $("score").textContent = Math.floor(score);
  const bb = $("bossbar");
  if (boss && boss.hp > 0) {
    bb.classList.remove("hidden");
    $("bossfill").style.width = clamp(boss.hp / boss.maxHp, 0, 1) * 100 + "%";
    $("bosstimer").textContent = "";
  } else {
    bb.classList.add("hidden");
    const rem = Math.max(0, nextBossTime - gameTime), m = Math.floor(rem / 60), s = Math.floor(rem % 60);
    $("bosstimer").textContent = `👹 Boss dans ${m}:${String(s).padStart(2, "0")}`;
  }
  $("hp").style.width = clamp(player.hp / player.maxHp, 0, 1) * 100 + "%";
  $("hptxt").textContent = `${Math.max(0, Math.ceil(player.hp))} / ${player.maxHp}`;
  $("weap").textContent = `${player.weapon.ico || "🔫"} ${player.weapon.name} Nv.${player.weapon.lvl}`;
  $("kills").textContent = "☠ " + kills;
  let bf = "";
  if (player.shield > 0) bf += `🛡️ ${player.shield.toFixed(1)}<br>`;
  if (player.speedBuff > 0) bf += `👟 ${player.speedBuff.toFixed(1)}<br>`;
  if (player.frenzy > 0) bf += `⚡ ${player.frenzy.toFixed(1)}<br>`;
  if (!soundOn) bf += "🔇";
  $("buffs").innerHTML = bf;
  const slots = document.querySelectorAll(".slot");
  for (let i = 0; i < 3; i++) {
    const key = player.inv[i];
    slots[i].classList.toggle("armed", armed === i);
    slots[i].childNodes[1] ? null : null;
    slots[i].innerHTML = `<span class="n">${i+1}</span>` + (key ? ITEMS[key].ico : "");
  }
  if (toastT > 0) { toastT -= 1/60; $("toast").textContent = "▶ " + toastMsg; $("toast").style.opacity = clamp(toastT, 0, 1); }
  else $("toast").style.opacity = 0;
}

function die() {
  state = "dead"; playerMesh.visible = false; if (petMesh) petMesh.visible = false; beep(80, 0.5, "sawtooth", 0.06);
  const m = Math.floor(gameTime / 60), s = Math.floor(gameTime % 60);
  $("deathStats").innerHTML = `<div><b>${Math.floor(score)}</b>Score</div><div><b>${kills}</b>Éliminés</div><div><b>${m}:${String(s).padStart(2,"0")}</b>Survie</div>`;
  const inp = $("nameInput"); inp.value = localStorage.getItem("hs_name") || "";
  $("nameRow").style.display = "flex"; $("lbStatus").textContent = ""; $("board").innerHTML = "";
  $("deathScreen").classList.remove("hidden"); inp.focus();
}

// ============================================================
//  CLASSEMENT
// ============================================================
const LB_ON = !!(LEADERBOARD.supabaseUrl && LEADERBOARD.supabaseKey);
async function submitScore(name, sc) {
  if (LB_ON) {
    const h = { apikey: LEADERBOARD.supabaseKey, Authorization: "Bearer " + LEADERBOARD.supabaseKey, "Content-Type": "application/json", Prefer: "return=minimal" };
    await fetch(LEADERBOARD.supabaseUrl + "/rest/v1/scores", { method:"POST", headers:h, body: JSON.stringify({ name, score: sc }) });
  } else { const l = JSON.parse(localStorage.getItem("hs_board") || "[]"); l.push({ name, score: sc }); localStorage.setItem("hs_board", JSON.stringify(l)); }
}
async function fetchTop() {
  if (LB_ON) {
    const h = { apikey: LEADERBOARD.supabaseKey, Authorization: "Bearer " + LEADERBOARD.supabaseKey };
    const res = await fetch(LEADERBOARD.supabaseUrl + "/rest/v1/scores?select=name,score&order=score.desc&limit=10", { headers: h });
    return await res.json();
  }
  return JSON.parse(localStorage.getItem("hs_board") || "[]").sort((a,b) => b.score - a.score).slice(0, 10);
}
async function saveAndShow() {
  if (scoreSaved) return; scoreSaved = true;
  const name = ($("nameInput").value || "Anonyme").slice(0, 12); localStorage.setItem("hs_name", name);
  $("lbStatus").textContent = LB_ON ? "Envoi au classement mondial…" : "Classement LOCAL (mondial non configuré)";
  $("nameRow").style.display = "none";
  try { await submitScore(name, Math.floor(score)); } catch (e) { $("lbStatus").textContent = "Erreur réseau — score gardé en local."; }
  const top = await fetchTop().catch(() => []); const board = $("board"); board.innerHTML = "";
  top.forEach((row, i) => { const li = document.createElement("li"); if (row.name === name && Math.floor(score) === row.score) li.className = "me";
    li.innerHTML = `<span class="rk">${i+1}</span><span class="nm">${esc(row.name)}</span><span class="sc">${row.score}</span>`; board.appendChild(li); });
  if (!top.length) board.innerHTML = "<li>Aucun score pour l'instant.</li>";
}
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;" }[c])); }

// ============================================================
//  UI
// ============================================================
const bossSlider = $("bossSlider");
bossSlider.addEventListener("input", () => {
  const v = +bossSlider.value;
  $("bossVal").textContent = v === 0 ? "Direct" : `${Math.floor(v/60)}:${String(v%60).padStart(2,"0")}`;
});
// curseur de densité d'ennemis (écran de création) : multiplicateur de la horde
const densSlider = $("densSlider");
densSlider.addEventListener("input", () => {
  const v = +densSlider.value;
  $("densVal").textContent = v === 0 ? "Aucun" : "✕" + v.toFixed(1);
});
if (!IS_LOCAL) {   // en prod : on retire l'indice de la touche B (debug local)
  const keysEl = document.querySelector("#menuScreen .keys");
  if (keysEl) keysEl.innerHTML = keysEl.innerHTML.replace(" · B : boss immédiat", "");
  // ...et on masque les réglages avancés (boss/densité) : sur le serveur on crée
  // juste une partie aux valeurs par défaut. Réglables uniquement en local.
  $("bossSetting")?.classList.add("hidden");
  $("densSetting")?.classList.add("hidden");
}
// détection tactile -> instructions adaptées au mobile
const IS_TOUCH = ("ontouchstart" in window) || navigator.maxTouchPoints > 0;
if (IS_TOUCH) {
  const k = document.querySelector("#menuScreen .keys");
  if (k) k.innerHTML = "👆 Tape sur le sol pour te déplacer<br>Objets : tape un slot, puis tape où viser<br>Le tir est automatique";
}
// pré-remplit le pseudo depuis la dernière session
$("pseudoInput").value = localStorage.getItem("hs_name") || "";

// ---- Liste des parties en cours (écran Rejoindre) ----
let partyPoll = null;
function stopPartyPoll() { if (partyPoll) { clearInterval(partyPoll); partyPoll = null; } }
async function refreshParties() {
  const list = $("partyList");
  const parties = await listArenas();
  list.innerHTML = "";
  $("joinEmpty").classList.toggle("hidden", parties.length > 0);
  for (const p of parties) {
    const full = p.clients >= p.maxClients;
    const bossTxt = p.bossDelay === 0 ? "Direct" : `${Math.floor(p.bossDelay/60)}:${String(p.bossDelay%60).padStart(2,"0")}`;
    const li = document.createElement("li");
    if (full) li.className = "full";
    li.innerHTML = `<span class="pn">${esc(p.partyName)}</span>` +
      `<span class="pm">👤 ${esc(p.host)} · ${p.clients}/${p.maxClients} joueurs · 🧟 ✕${(+p.density).toFixed(1)} · ⏱ ${bossTxt}</span>`;
    if (!full) li.onclick = () => joinGame(p.roomId);
    list.appendChild(li);
  }
}
// Valide le pseudo saisi puis ouvre le lobby (créer / rejoindre) avec rafraîchissement live.
function openLobby() {
  const name = getPseudo(); // valide + persiste le pseudo
  showScreen("lobbyScreen");
  const hello = $("lobbyHello");
  if (hello) hello.textContent = `Salut ${name} 👋`;
  refreshParties();
  stopPartyPoll();
  partyPoll = setInterval(refreshParties, 3000); // rafraîchit tant que le lobby est ouvert
}

// ---- Navigation des écrans d'accueil ----
$("pseudoContinueBtn").onclick = openLobby;
$("pseudoInput").addEventListener("keydown", e => { if (e.key === "Enter") openLobby(); });
$("changePseudoBtn").onclick = () => { stopPartyPoll(); showScreen("pseudoScreen"); };
$("refreshBtn").onclick = refreshParties;
$("createBtn").onclick = createGame;
$("againBtn").onclick = backToMenu;
$("saveBtn").onclick = saveAndShow;
$("nameInput").addEventListener("keydown", e => { if (e.key === "Enter") saveAndShow(); });
