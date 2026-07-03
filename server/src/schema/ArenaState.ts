import { Schema, MapSchema, type } from "@colyseus/schema";

// État répliqué d'un joueur. C'est CE qui est synchronisé (delta binaire auto)
// vers tous les clients de la room.
export class Player extends Schema {
  @type("number") x = 0;
  @type("number") z = 0;
  @type("number") aim = 0; // orientation (radians)
  @type("string") name = "";
}

// État global de l'arène : la table des joueurs présents.
export class ArenaState extends Schema {
  @type({ map: Player }) players = new MapSchema<Player>();
}
