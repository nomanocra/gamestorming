import { Room, Client } from "colyseus";
import { ArenaState, Player } from "../schema/ArenaState";

// L'arène partagée — Jalon 1 (présence).
//  - maxClients = 4        -> plafond de joueurs par instance
//  - autoDispose (défaut)  -> la room se détruit quand le dernier joueur part
export class ArenaRoom extends Room<ArenaState> {
  maxClients = 4;

  onCreate() {
    this.setState(new ArenaState());

    // Le client envoie sa position (présence). Pas encore autoritaire :
    // on la stocke telle quelle dans l'état répliqué (upgrade au Jalon 4).
    this.onMessage("pos", (client, data: { x: number; z: number; aim: number }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      p.x = data.x;
      p.z = data.z;
      p.aim = data.aim;
    });

    console.log(`[arena] room créée: ${this.roomId}`);
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
