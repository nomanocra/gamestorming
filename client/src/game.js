import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import * as SkeletonUtils from "three/addons/utils/SkeletonUtils.js";
import { connectArena, sendPos, sendHit, sendDensity, sendShot, onShot, getRoom, getSessionId } from "./net/room";

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
function applyCamAspect() { camera.aspect = W / H; camera.updateProjectionMatrix(); }
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
//  MONDE INFINI : sol qui suit le joueur + génération par chunks
// ============================================================
// sol infini : un grand plan recentré sur le joueur à chaque frame
const ground = new THREE.Mesh(new THREE.PlaneGeometry(700, 700),
  new THREE.MeshStandardMaterial({ color: 0x5a8c46, roughness: 0.95 }));
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);

// assets de props PARTAGÉS (géométries/matériaux réutilisés -> pas de fuite mémoire)
const trunkGeo = new THREE.CylinderGeometry(0.35, 0.4, 1.2, 5);
const topGeo   = new THREE.ConeGeometry(1.6, 4, 6);
const rockGeo  = new THREE.IcosahedronGeometry(1, 0);
const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2f, flatShading: true });
const rockMat  = new THREE.MeshStandardMaterial({ color: 0x8a8f9c, flatShading: true });
const topMats  = [0xe86fa0, 0x8fd67a, 0x7ec8e3, 0xf0c85a].map(c => new THREE.MeshStandardMaterial({ color: c, flatShading: true }));

// PRNG déterministe par chunk -> un chunk se régénère IDENTIQUE si on y revient
function chunkRand(cx, cz, i) {
  let s = (cx * 374761393 + cz * 668265263 + i * 1274126177) >>> 0;
  s = ((s ^ (s >>> 13)) * 1274126177) >>> 0;
  return ((s ^ (s >>> 16)) >>> 0) / 4294967296;
}
const CHUNK = 40, VIEW = 3;          // taille d'un chunk, rayon de chunks chargés autour du joueur
const loadedChunks = new Map();
function buildChunk(cx, cz) {
  const g = new THREE.Group();
  const n = 3 + Math.floor(chunkRand(cx, cz, 0) * 6);   // 3 à 8 props par chunk
  for (let i = 0; i < n; i++) {
    const rx = chunkRand(cx, cz, i*4+1), rz = chunkRand(cx, cz, i*4+2);
    const rt = chunkRand(cx, cz, i*4+3), rs = chunkRand(cx, cz, i*4+4);
    const x = cx * CHUNK + rx * CHUNK, z = cz * CHUNK + rz * CHUNK;
    let m;
    if (rt < 0.55) { // arbre
      const grp = new THREE.Group();
      const trunk = new THREE.Mesh(trunkGeo, trunkMat); trunk.position.y = 0.6; trunk.castShadow = true;
      const top = new THREE.Mesh(topGeo, topMats[Math.floor(rs * topMats.length) % topMats.length]);
      top.position.y = 3; top.castShadow = true; top.scale.setScalar(0.8 + rs * 0.6);
      grp.add(trunk, top); m = grp;
    } else { // rocher
      m = new THREE.Mesh(rockGeo, rockMat); const s = 1 + rs * 1.2;
      m.scale.setScalar(s); m.position.y = 0.55 * s; m.castShadow = true;
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
  for (const [k, g] of loadedChunks) if (!need.has(k)) { scene.remove(g); loadedChunks.delete(k); } // décharge derrière
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
  if (!raycaster.ray.intersectPlane(groundPlane, aimPoint)) return;
  if (key === "bombe") {
    bombPrev.visible = true; bombPrev.position.set(aimPoint.x, 0.06, aimPoint.z);
  } else if (key === "laser") {
    const a = Math.atan2(aimPoint.z - player.z, aimPoint.x - player.x);
    laserPrev.visible = true;
    laserPrev.position.set(player.x + Math.cos(a) * 50, 0.9, player.z + Math.sin(a) * 50);
    laserPrev.rotation.y = -a;
  } else if (key === "grenade") {
    grenadePrev.visible = true; grenadePrev.position.set(aimPoint.x, 0.06, aimPoint.z);
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

function startGame() {
  if (enemies) { clearGroup(enemies); clearGroup(bullets); clearGroup(pickups); clearGroup(effects); clearGroup(particles); clearGroup(enemyBullets); }
  for (const s of remoteShots) scene.remove(s.mesh); remoteShots.length = 0;
  player = newPlayer();
  if (!playerMesh) { playerMesh = buildPlayerMesh(); scene.add(playerMesh); }
  playerMesh.visible = true;
  if (!petMesh) { petMesh = buildPetMesh(); scene.add(petMesh); }
  petMesh.visible = true;
  enemies = []; bullets = []; pickups = []; effects = []; particles = []; enemyBullets = [];
  gameTime = 0; spawnTimer = 0; kills = 0; score = 0; armed = -1; shake = 0; scoreSaved = false;
  const sl = document.getElementById("bossSlider");
  bossDelay = (IS_LOCAL && sl) ? +sl.value : BOSS_TIME;
  boss = null; nextBossTime = bossDelay;
  document.getElementById("startScreen").classList.add("hidden");
  document.getElementById("deathScreen").classList.add("hidden");
  document.getElementById("hud").classList.remove("hidden");
  state = "play"; lastT = performance.now();
  // densité de horde voulue (curseur de test, local uniquement)
  const ds = document.getElementById("densSlider");
  wantDensity = (IS_LOCAL && ds) ? +ds.value : 1;
  sentDensity = -1; // force le renvoi au serveur (utile si on est l'hôte)
  // --- multijoueur : rejoindre l'arène partagée. Idempotent. ---
  // density/bossDelay ne s'appliquent que si on est le 1er joueur (hôte) qui crée la room.
  connectArena((localStorage.getItem("hs_name") || "Joueur").slice(0, 12), { density: wantDensity, bossDelay });
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
  if (e.code === "KeyR" && state === "dead") startGame();
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
function pointerToGround(e, out) {   // met à jour la visée + renvoie le point au sol sous le doigt/souris
  mouseNDC.x = (e.clientX / W) * 2 - 1; mouseNDC.y = -(e.clientY / H) * 2 + 1;
  raycaster.setFromCamera(mouseNDC, camera);
  return raycaster.ray.intersectPlane(groundPlane, out);
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
  ring.rotation.x = -Math.PI / 2; ring.position.set(x, 0.5, z); scene.add(ring);
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
function dropPickup(x, z, kind, key) {
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
  pickups.push({ x, z, kind, key, ico, r: 1.4, bob: rand(0, 6.28), mesh: g });
}

// ============================================================
//  PARTICULES
// ============================================================
function spawnParticles(x, z, col, n) {
  const mat = new THREE.MeshBasicMaterial({ color: col });
  for (let i = 0; i < n; i++) {
    const a = rand(0, 6.28), s = rand(4, 16);
    const m = new THREE.Mesh(GEO.particle, mat);
    m.position.set(x, 1, z); scene.add(m);
    particles.push({ x, z, y:1, vx:Math.cos(a)*s, vz:Math.sin(a)*s, vy:rand(4,10), life:rand(0.3,0.6), mesh:m });
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
  ground.position.set(px, 0, pz);   // sol infini qui suit le joueur
  updateChunks(px, pz);             // génère/décharge le monde autour de lui
  const sx = shake > 0 ? rand(-shake, shake) : 0, sz = shake > 0 ? rand(-shake, shake) : 0;
  camera.position.set(px + CAM_OFF.x + sx, CAM_OFF.y, pz + CAM_OFF.z + sz);
  camera.lookAt(px, 0, pz);
  sun.position.set(px + 40, 80, pz + 20); sun.target.position.set(px, 0, pz);
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
const NET_HZ = 15;                  // fréquence d'envoi de la position
let wantDensity = 1, sentDensity = -1;   // densité de horde voulue (outil de test)

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
    ring.rotation.x = -Math.PI / 2; ring.position.set(d.x, 0.5, d.z); scene.add(ring);
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
      s.mesh.position.set(s.x, BULLET_Y, s.z);
      if (s.type === "boomerang") s.mesh.rotation.y += 0.7;
    } else if (s.type === "boom") {
      const k = 1 - s.life / s.max;
      s.mesh.scale.setScalar(0.5 + s.radius * k);
      s.mesh.material.transparent = true; s.mesh.material.opacity = Math.max(0, s.life / s.max);
    } else if (s.type === "laser") {
      s.mesh.position.set(s.x + Math.cos(s.ang) * s.len / 2, 1.1, s.z + Math.sin(s.ang) * s.len / 2);
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
      scene.remove(av.group);
      av = makeRemoteAvatar(av.group.position.x, av.group.position.z);
      remoteAvatars.set(id, av);
    }
    const g = av.group;
    g.position.x += (p.x - g.position.x) * 0.25;
    g.position.z += (p.z - g.position.z) * 0.25;
    // orientation du CORPS via `face` (identique au joueur local)
    g.rotation.y = (p.face || 0) + FACE_OFFSET;
    g.visible = (state === "play");
    // blend course/idle : distant = tant que l'avatar rattrape sa position serveur
    if (av.actRun) {
      const gap = Math.hypot(p.x - g.position.x, p.z - g.position.z);
      const t = gap > 0.15 ? 1 : 0;
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
  player.x += mx * player.speed * dt; player.z += mz * player.speed * dt;

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
    if (!e.net) { e.x += Math.cos(a) * e.speed * dt + e.kx; e.z += Math.sin(a) * e.speed * dt + e.kz; e.kx *= 0.86; e.kz *= 0.86; }
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
      if (p.kind === "weapon") {
        const lv = (player.weaponLvl[p.key] || 0) + 1; player.weaponLvl[p.key] = lv;
        player.weapon = computeWeapon(p.key, lv);
        toast(`${player.weapon.ico} ${player.weapon.name} Nv.${lv}`); beep(900,0.1,"square",0.04);
      }
      else if (p.kind === "buff") { BUFFS[p.key].apply(player); beep(1000,0.08,"sine",0.03); }
      else { if (!addItem(p.key)) continue; beep(760,0.08,"square",0.03); }
      scene.remove(p.mesh); pickups.splice(i, 1);
    }
  }

  // particules
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx * dt; p.z += p.vz * dt; p.y += p.vy * dt; p.vy -= 30 * dt; p.vx *= 0.92; p.vz *= 0.92; p.life -= dt;
    if (p.life <= 0 || p.y < 0) { scene.remove(p.mesh); particles.splice(i, 1); }
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
  playerMesh.position.set(player.x, 0, player.z);
  playerMesh.rotation.y = player.face + FACE_OFFSET;
  playerMesh.visible = !(player.iframe > 0 && Math.floor(gameTime * 20) % 2);
  // bouclier : bulle translucide autour du perso quand actif
  shieldMesh.visible = (state === "play") && player.shield > 0;
  if (shieldMesh.visible) {
    shieldMesh.position.set(player.x, 1.2, player.z);
    shieldMesh.scale.setScalar(1 + Math.sin(gameTime * 8) * 0.06);
  }
  // compagnon volant : au-dessus de la tête, bob + anneau tournant + visée
  if (petMesh) {
    petMesh.position.set(player.x, 4.0 + Math.sin(gameTime * 2.5) * 0.25, player.z);
    petMesh.userData.ring.rotation.z += 0.05;
    if (player.hasAim) petMesh.rotation.y = Math.PI / 2 - player.aim;
  }
  for (const e of enemies) {
    e.mesh.position.set(e.x, e.r, e.z); e.mesh.rotation.y += e.spin * 0.02;
    e.mesh.material = e.flash > 0 ? whiteMat : (e.mat || MAT[matKey(e)]);
    // barre de vie : visible dès qu'on l'a touché, billboard face caméra
    const ratio = clamp(e.hp / e.maxHp, 0, 1);
    e.bar.visible = e.hp < e.maxHp;
    if (e.bar.visible) {
      e.bar.position.set(e.x, e.r * 2 + 1.2, e.z);
      e.bar.quaternion.copy(camera.quaternion);
      const f = e.bar.userData.fill, w = e.bar.userData.w;
      f.scale.x = ratio; f.position.x = -w * (1 - ratio) / 2;
      f.material.color.setHSL(0.33 * ratio, 0.85, 0.5);
    }
  }
  for (const b of bullets) b.mesh.position.set(b.x, BULLET_Y, b.z);
  for (const b of enemyBullets) b.mesh.position.set(b.x, BULLET_Y, b.z);
  for (const p of pickups) { p.mesh.position.set(p.x, 1.2 + Math.sin(gameTime * 3 + p.bob) * 0.25, p.z); p.mesh.rotation.y += 0.03; }
  for (const p of particles) p.mesh.position.set(p.x, p.y, p.z);
  for (const f of effects) {
    if (f.type === "boomerang") { f.mesh.position.set(f.x, BULLET_Y, f.z); f.mesh.rotation.y += 0.7; }
    else if (f.type === "boom") { const k = 1 - f.life / f.max; f.mesh.scale.setScalar(0.5 + f.radius * k); f.mesh.material.opacity = f.life / f.max; f.mesh.material.transparent = true; }
    else if (f.type === "laser") {
      f.mesh.position.set(player.x + Math.cos(f.ang) * f.len / 2, 1.1, player.z + Math.sin(f.ang) * f.len / 2);
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
// curseur de densité d'ennemis (outil de test) : multiplicateur envoyé au serveur
const densSlider = $("densSlider");
densSlider.addEventListener("input", () => {
  const v = +densSlider.value;
  $("densVal").textContent = v === 0 ? "Aucun" : "✕" + v.toFixed(1);
  wantDensity = v;   // appliqué en direct : netSync le pousse au serveur au prochain frame
});
if (!IS_LOCAL) {   // en prod : on cache les curseurs de test et l'indice de la touche B
  document.querySelectorAll("#startScreen .setting").forEach(el => el.style.display = "none");
  const keysEl = document.querySelector("#startScreen .keys"); if (keysEl) keysEl.innerHTML = keysEl.innerHTML.replace(" · B : boss immédiat", "");
}
// détection tactile -> instructions adaptées au mobile
const IS_TOUCH = ("ontouchstart" in window) || navigator.maxTouchPoints > 0;
if (IS_TOUCH) {
  const k = document.querySelector("#startScreen .keys");
  if (k) k.innerHTML = "👆 Tape sur le sol pour te déplacer<br>Objets : tape un slot, puis tape où viser<br>Le tir est automatique";
}
$("startBtn").onclick = () => { if (!AC) try { AC = new (window.AudioContext||window.webkitAudioContext)(); } catch(e){} startGame(); };
$("againBtn").onclick = startGame;
$("saveBtn").onclick = saveAndShow;
$("nameInput").addEventListener("keydown", e => { if (e.key === "Enter") saveAndShow(); });
