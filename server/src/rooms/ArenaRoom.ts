import { Room, Client } from "colyseus";
import { ArenaState, Player, Enemy } from "../schema/ArenaState";

const TICK_MS = 50; // simulation à 20 Hz
const MAX_ENEMIES = 220; // garde-fou (serveur Node mono-thread)

type EnemyType = { kind: string; r: number; speed: number; hp: number; dmg: number; sc: number };

// Réplique fidèlement enemyType() du client : le type dépend du temps écoulé.
function rollEnemyType(elapsed: number): EnemyType {
  const r = Math.random();
  if (elapsed > 55 && r < 0.15) return { kind: "brute", r: 2.0, speed: 3.9, hp: 70 + elapsed * 1.3, dmg: 24, sc: 50 };
  if (elapsed > 22 && r < 0.35) return { kind: "runner", r: 0.75, speed: 11.5, hp: 12 + elapsed * 0.4, dmg: 6, sc: 15 };
  return { kind: "grunt", r: 1.1, speed: 5.4, hp: 22 + elapsed * 0.7, dmg: 9, sc: 10 };
}

// L'arène partagée — Jalon 4 : horde AUTORITAIRE côté serveur.
export class ArenaRoom extends Room<ArenaState> {
  maxClients = 4;

  private spawnAcc = 0; // accumulateur de cadence de spawn
  private seq = 0; // compteur d'ids d'ennemis
  private meta = new Map<string, { speed: number; sc: number }>(); // par ennemi, non répliqué

  onCreate() {
    this.setState(new ArenaState());

    // présence : position du joueur
    this.onMessage("pos", (client, d: { x: number; z: number; aim: number }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      p.x = d.x;
      p.z = d.z;
      p.aim = d.aim;
    });

    // dégâts : le client détecte la collision balle/ennemi (réactif) et signale.
    // Le serveur reste AUTORITAIRE sur les hp et la mort (pas de triche en co-op PvE).
    this.onMessage("hit", (_client, d: { id: string; dmg: number }) => {
      const e = this.state.enemies.get(d.id);
      if (!e) return;
      e.hp -= d.dmg;
      if (e.hp <= 0) {
        const m = this.meta.get(d.id);
        this.state.kills++;
        this.state.score += m ? m.sc : 10;
        this.state.enemies.delete(d.id);
        this.meta.delete(d.id);
      }
    });

    this.setSimulationInterval((dtMs) => this.tick(dtMs / 1000), TICK_MS);
    console.log(`[arena] room créée: ${this.roomId}`);
  }

  private tick(dt: number) {
    const players = [...this.state.players.values()];
    if (players.length === 0) return; // pas de cible -> pas de horde

    this.state.elapsed += dt;

    // --- spawn (même cadence que le solo) ---
    this.spawnAcc -= dt;
    if (this.spawnAcc <= 0 && this.state.enemies.size < MAX_ENEMIES) {
      this.spawnAcc = Math.max(0.16, 1.1 - this.state.elapsed * 0.013);
      this.spawnEnemy(players);
    }

    // --- IA : chaque ennemi fonce vers le joueur le plus proche ---
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
    e.r = t.r;
    e.hp = t.hp;
    e.maxHp = t.hp;
    e.kind = t.kind;
    const id = "e" + this.seq++;
    this.state.enemies.set(id, e);
    this.meta.set(id, { speed: t.speed, sc: t.sc });
  }

  onJoin(client: Client, options?: { name?: string }) {
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
