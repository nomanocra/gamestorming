import { Room, Client } from "colyseus";
import { ArenaState, Player, Enemy, Pickup } from "../schema/ArenaState";

// Pools de butin — DOIVENT rester alignés avec les définitions client (game.js).
const WEAPON_KEYS = ["pistolet", "mitraillette", "pompe", "canon", "triple", "flamme"];
const ITEM_KEYS = ["bombe", "laser", "grenade"];
// pioche pondérée : le soin (vie) est ~2x plus rare que les autres buffs
const BUFF_POOL = ["bouclier", "bouclier", "vitesse", "vitesse", "frenesie", "frenesie", "soin"];
const GRAB_RANGE2 = 25; // distance² max autorisée pour ramasser (garde-fou anti-triche)

const pickOne = <T>(arr: T[]): T => arr[(Math.random() * arr.length) | 0];

const TICK_MS = 50; // simulation à 20 Hz
const MAX_ENEMIES = 400; // garde-fou absolu (limite de rendu client mobile, pas le serveur)
const BASE_CAP = 100; // population cible à densité ✕1 pour 1 joueur
// Le cap monte avec le nb de joueurs : chaque joueur en plus ajoute 1× (k=1).
// À densité ✕1 -> 100 / 200 / 300 / 400 ennemis pour 1 / 2 / 3 / 4 joueurs.
const PLAYER_SCALE = 1;

type EnemyType = { kind: string; r: number; speed: number; hp: number; dmg: number; sc: number };

function rollEnemyType(elapsed: number): EnemyType {
  const r = Math.random();
  if (elapsed > 55 && r < 0.15) return { kind: "brute", r: 2.0, speed: 3.9, hp: 70 + elapsed * 1.3, dmg: 24, sc: 50 };
  if (elapsed > 22 && r < 0.35) return { kind: "runner", r: 0.75, speed: 11.5, hp: 12 + elapsed * 0.4, dmg: 6, sc: 15 };
  return { kind: "grunt", r: 1.1, speed: 5.4, hp: 22 + elapsed * 0.7, dmg: 9, sc: 10 };
}

function clampNum(v: unknown, lo: number, hi: number, def: number): number {
  const n = typeof v === "number" && isFinite(v) ? v : def;
  return Math.max(lo, Math.min(hi, n));
}

// L'arène partagée — horde AUTORITAIRE côté serveur.
// Les paramètres (densité, délai boss) appartiennent à l'HÔTE (1er joueur).
export class ArenaRoom extends Room<ArenaState> {
  maxClients = 4;

  private spawnAcc = 0;
  private seq = 0;
  private meta = new Map<string, { speed: number; sc: number }>();
  private hostId: string | null = null; // 1er joueur = définit/modifie les params
  private density = 1; // 0..2
  private bossDelay = 300; // s avant le boss (0 = direct)
  private nextBoss = 300;
  private bossId: string | null = null;

  onCreate(options?: { density?: number; bossDelay?: number; partyName?: string; name?: string }) {
    this.setState(new ArenaState());
    // paramètres définis par le joueur qui instancie la room (l'hôte)
    this.density = clampNum(options?.density, 0, 2, 1);
    this.bossDelay = clampNum(options?.bossDelay, 0, 300, 300);
    this.nextBoss = this.bossDelay;

    // metadata : ce que la liste des parties (lobby) affiche AVANT de rejoindre.
    // clients / maxClients sont remontés nativement par getAvailableRooms().
    const host = (options?.name ?? "Joueur").slice(0, 12);
    const partyName = (options?.partyName?.trim() || `Partie de ${host}`).slice(0, 24);
    this.setMetadata({ partyName, host, density: this.density, bossDelay: this.bossDelay });

    this.onMessage("pos", (client, d: { x: number; z: number; aim: number; face?: number }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      p.x = d.x; p.z = d.z; p.aim = d.aim;
      if (typeof d.face === "number") p.face = d.face;
    });

    // Relais COSMÉTIQUE des projectiles d'un joueur (tir arme / objet lancé).
    // Le serveur ne simule PAS ces projectiles : ils sont purement visuels chez
    // les autres joueurs. Les dégâts restent gérés par le tireur via "hit"
    // (le serveur reste autoritaire sur les hp) -> aucun risque de double dégât.
    this.onMessage("shot", (client, d: unknown) => {
      if (!d || typeof d !== "object") return;
      this.broadcast("shot", { ...(d as object), from: client.sessionId }, { except: client });
    });

    this.onMessage("hit", (_client, d: { id: string; dmg: number }) => {
      const e = this.state.enemies.get(d.id);
      if (!e) return;
      e.hp -= d.dmg;
      if (e.hp <= 0) this.killEnemy(d.id);
    });

    // Ramassage d'un butin : le serveur valide la proximité, retire le pickup pour
    // TOUS (via l'état répliqué) et renvoie l'effet au SEUL ramasseur (l'arme/buff
    // ne concerne que son perso). Le premier à réclamer un pickup l'emporte.
    this.onMessage("grab", (client, d: { id: string }) => {
      const p = this.state.pickups.get(d?.id);
      if (!p) return; // déjà ramassé par quelqu'un d'autre
      const pl = this.state.players.get(client.sessionId);
      if (!pl) return;
      const dx = pl.x - p.x, dz = pl.z - p.z;
      if (dx * dx + dz * dz > GRAB_RANGE2) return; // trop loin -> ignoré
      client.send("grabbed", { kind: p.kind, key: p.key });
      this.state.pickups.delete(d.id);
    });

    // seul l'hôte peut modifier les params en cours de partie (outil de test)
    this.onMessage("density", (client, d: { d: number }) => {
      if (client.sessionId !== this.hostId) return;
      this.density = clampNum(d?.d, 0, 2, 1);
      this.setMetadata({ density: this.density }); // garde la liste des parties à jour
    });
    this.onMessage("bossDelay", (client, d: { d: number }) => {
      if (client.sessionId !== this.hostId) return;
      this.bossDelay = clampNum(d?.d, 0, 300, 300);
      if (!this.bossId) this.nextBoss = this.bossDelay;
      this.setMetadata({ bossDelay: this.bossDelay });
    });

    this.setSimulationInterval((dtMs) => this.tick(dtMs / 1000), TICK_MS);
    console.log(`[arena] room créée: ${this.roomId} (densité ✕${this.density}, boss ${this.bossDelay}s)`);
  }

  private tick(dt: number) {
    const players = [...this.state.players.values()];
    if (players.length === 0) return;
    this.state.elapsed += dt;

    // facteur d'échelle co-op : 1 joueur -> 1, +1 par joueur supplémentaire (k=1)
    const playerScale = 1 + (players.length - 1) * PLAYER_SCALE;

    if (!this.bossId) {
      // phase horde normale, pilotée par la densité ET le nb de joueurs (cap + taux de spawn)
      const cap = Math.min(MAX_ENEMIES, Math.round(BASE_CAP * this.density * playerScale));
      if (this.state.enemies.size > cap) {
        const ids = [...this.state.enemies.keys()];
        for (let k = cap; k < ids.length; k++) this.killEnemy(ids[k], true); // culling silencieux
      }
      if (this.state.elapsed < this.nextBoss) {
        this.spawnAcc -= dt;
        if (this.spawnAcc <= 0 && this.state.enemies.size < cap) {
          // le rythme de spawn accélère avec la densité et le nb de joueurs -> remplit le cap plus vite
          this.spawnAcc = Math.max(0.16, 1.1 - this.state.elapsed * 0.013) / Math.max(0.25, this.density * playerScale);
          this.spawnEnemy(players);
        }
      } else if (this.state.enemies.size === 0) {
        this.spawnBoss(players);
      }
    }

    // IA : tous les ennemis (boss inclus) foncent vers le joueur le plus proche
    this.state.enemies.forEach((e, id) => {
      let tx = e.x, tz = e.z, best = Infinity;
      for (const p of players) {
        const dx = p.x - e.x, dz = p.z - e.z, d = dx * dx + dz * dz;
        if (d < best) { best = d; tx = p.x; tz = p.z; }
      }
      const dx = tx - e.x, dz = tz - e.z;
      const len = Math.hypot(dx, dz) || 1;
      const sp = this.meta.get(id)?.speed ?? 5;
      e.x += (dx / len) * sp * dt;
      e.z += (dz / len) * sp * dt;
    });
  }

  private spawnEnemy(players: Player[]) {
    const anchor = players[(Math.random() * players.length) | 0];
    const a = Math.random() * Math.PI * 2;
    const t = rollEnemyType(this.state.elapsed);
    const e = new Enemy();
    e.x = anchor.x + Math.cos(a) * 44;
    e.z = anchor.z + Math.sin(a) * 44;
    e.r = t.r; e.hp = t.hp; e.maxHp = t.hp; e.kind = t.kind;
    const id = "e" + this.seq++;
    this.state.enemies.set(id, e);
    this.meta.set(id, { speed: t.speed, sc: t.sc });
  }

  private spawnBoss(players: Player[]) {
    const anchor = players[(Math.random() * players.length) | 0];
    const a = Math.random() * Math.PI * 2;
    const hp = 3500 + this.state.elapsed * 8;
    const e = new Enemy();
    e.x = anchor.x + Math.cos(a) * 46;
    e.z = anchor.z + Math.sin(a) * 46;
    e.r = 5; e.hp = hp; e.maxHp = hp; e.kind = "boss";
    const id = "boss" + this.seq++;
    this.state.enemies.set(id, e);
    this.meta.set(id, { speed: 4.6, sc: 1500 });
    this.bossId = id;
    console.log(`[arena] boss spawn (${this.roomId})`);
  }

  private killEnemy(id: string, culled = false) {
    const e = this.state.enemies.get(id);
    if (!e) return;
    if (!culled) {
      this.state.kills++;
      this.state.score += this.meta.get(id)?.sc ?? 10;
      // butin (autoritaire) : mêmes taux que le solo. Boss -> 6 drops garantis.
      if (id === this.bossId) {
        for (let k = 0; k < 6; k++) {
          const aa = Math.random() * Math.PI * 2;
          this.dropRandom(e.x + Math.cos(aa) * 4, e.z + Math.sin(aa) * 4);
        }
      } else {
        this.rollDrop(e.x, e.z);
      }
    }
    this.state.enemies.delete(id);
    this.meta.delete(id);
    if (id === this.bossId) {
      this.bossId = null;
      this.nextBoss = this.state.elapsed + this.bossDelay; // boss récurrent, comme le solo
    }
  }

  // Fait apparaître un butin dans l'état partagé (visible par tous les joueurs).
  private spawnPickup(x: number, z: number, kind: string, key: string) {
    const p = new Pickup();
    p.x = x; p.z = z; p.kind = kind; p.key = key;
    this.state.pickups.set("p" + this.seq++, p);
  }

  // Drop pondéré d'un ennemi normal : 5% arme, 8% objet, 17% buff, 70% rien.
  private rollDrop(x: number, z: number) {
    const r = Math.random();
    if (r < 0.05) this.spawnPickup(x, z, "weapon", pickOne(WEAPON_KEYS));
    else if (r < 0.13) this.spawnPickup(x, z, "item", pickOne(ITEM_KEYS));
    else if (r < 0.30) this.spawnPickup(x, z, "buff", pickOne(BUFF_POOL));
  }

  // Drop garanti (boss) : une catégorie au hasard, puis une clé dans cette catégorie.
  private dropRandom(x: number, z: number) {
    const tables: [string, string[]][] = [["weapon", WEAPON_KEYS], ["item", ITEM_KEYS], ["buff", BUFF_POOL]];
    const [kind, keys] = pickOne(tables);
    this.spawnPickup(x, z, kind, pickOne(keys));
  }

  onJoin(client: Client, options?: { name?: string }) {
    if (!this.hostId) this.hostId = client.sessionId; // 1er joueur = hôte
    const p = new Player();
    p.name = (options?.name ?? "Joueur").slice(0, 12);
    this.state.players.set(client.sessionId, p);
    console.log(`[arena] + ${client.sessionId} (${p.name}) -> ${this.state.players.size}/${this.maxClients}`);
  }

  onLeave(client: Client) {
    this.state.players.delete(client.sessionId);
    console.log(`[arena] - ${client.sessionId} -> ${this.state.players.size}/${this.maxClients}`);
  }

  onDispose() {
    console.log(`[arena] room détruite (vide): ${this.roomId}`);
  }
}
