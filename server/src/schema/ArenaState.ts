import { Schema, MapSchema, type } from "@colyseus/schema";

// État répliqué d'un joueur (présence).
export class Player extends Schema {
  @type("number") x = 0;
  @type("number") z = 0;
  @type("number") aim = 0; // orientation de TIR (radians) — vers la cible
  @type("number") face = 0; // orientation du CORPS / déplacement (radians)
  @type("string") name = "";
}

// Ennemi autoritaire : simulé par le serveur, répliqué à tous les clients.
// On ne réplique QUE ce dont le rendu a besoin (position, taille, hp, type).
// La vitesse / le score restent côté serveur (voir ArenaRoom.meta).
export class Enemy extends Schema {
  @type("number") x = 0;
  @type("number") z = 0;
  @type("number") r = 1;
  @type("number") hp = 10;
  @type("number") maxHp = 10;
  @type("string") kind = "grunt"; // "grunt" | "runner" | "brute"
}

// État global de l'arène.
export class ArenaState extends Schema {
  @type({ map: Player }) players = new MapSchema<Player>();
  @type({ map: Enemy }) enemies = new MapSchema<Enemy>();
  @type("number") elapsed = 0; // temps de jeu écoulé (s) -> pilote spawn & scaling
  @type("uint32") kills = 0; // kills partagés
  @type("number") score = 0; // score partagé
}
