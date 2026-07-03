import { Room, Client } from "colyseus";
import { ArenaState, Player, Enemy } from "../schema/ArenaState";

const TICK_MS = 50; // simulation à 20 Hz
const MAX_ENEMIES = 220; // garde-fou (serveur Node mono-thread)
const BASE_CAP = 100; // population cible à densité ✕1 (cap = BASE_CAP * densité)

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

  onCreate(options?: { density?: number; bossDelay?: number }) {
    this.setState(new ArenaState());
    // paramètres définis par le joueur qui instancie la room
    this.density = clampNum(options?.density, 0, 2, 1);
    this.bossDelay = clampNum(options?.bossDelay, 0, 300, 300);
    this.nextBoss = this.bossDelay;

    this.onMessage("pos", (client, d: { x: number; z: number; aim: number }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      p.x = d.x; p.z = d.z; p.aim = d.aim;
    });

    this.onMessage("hit", (_client, d: { id: string; dmg: number }) => {
      const e = this.state.enemies.get(d.id);
      if (!e) return;
      e.hp -= d.dmg;
      if (e.hp <= 0) this.killEnemy(d.id);
    });

    // seul l'hôte peut modifier les params en cours de partie (outil de test)
    this.onMessage("density", (client, d: { d: number }) => {
      if (client.sessionId !== this.hostId) return;
      this.density = clampNum(d?.d, 0, 2, 1);
    });
    this.onMessage("bossDelay", (client, d: { d: number }) => {
      if (client.sessionId !== this.hostId) return;
      this.bossDelay = clampNum(d?.d, 0, 300, 300);
      if (!this.bossId) this.nextBoss = this.bossDelay;
    });

    this.setSimulationInterval((dtMs) => this.tick(dtMs / 1000), TICK_MS);
    console.log(`[arena] room créée: ${this.roomId} (densité ✕${this.density}, boss ${this.bossDelay}s)`);
  }

  private tick(dt: number) {
    const players = [...this.state.players.values()];
    if (players.length === 0) return;
    this.state.elapsed += dt;

    if (!this.bossId) {
      // phase horde normale, pilotée par la densité (cap + taux de spawn)
      const cap = Math.min(MAX_ENEMIES, Math.round(BASE_CAP * this.density));
      if (this.state.enemies.size > cap) {
        const ids = [...this.state.enemies.keys()];
        for (let k = cap; k < ids.length; k++) this.killEnemy(ids[k], true); // culling silencieux
      }
      if (this.state.elapsed < this.nextBoss) {
        this.spawnAcc -= dt;
        if (this.spawnAcc <= 0 && this.state.enemies.size < cap) {
          this.spawnAcc = Math.max(0.16, 1.1 - this.state.elapsed * 0.013) / Math.max(0.25, this.density);
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
    if (!this.state.enemies.has(id)) return;
    if (!culled) {
      this.state.kills++;
      this.state.score += this.meta.get(id)?.sc ?? 10;
    }
    this.state.enemies.delete(id);
    this.meta.delete(id);
    if (id === this.bossId) {
      this.bossId = null;
      this.nextBoss = this.state.elapsed + this.bossDelay; // boss récurrent, comme le solo
    }
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
