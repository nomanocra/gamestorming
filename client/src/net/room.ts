// ============================================================
//  Couche réseau client (Colyseus) — Jalon 1 : présence
//  Rôle : se connecter à l'arène partagée, envoyer sa position,
//  exposer l'état de la room. Le RENDU des joueurs distants est
//  fait dans game.js (qui possède THREE + la scène).
// ============================================================
import { Client, Room } from "colyseus.js";

let room: Room | null = null;
let connecting = false;

function endpoint(): string {
  // Prod : défini via VITE_SERVER_URL (ex: wss://mon-serveur.fly.dev).
  // Local : même hôte que la page, port 2567.
  const fromEnv = (import.meta as any).env?.VITE_SERVER_URL;
  if (fromEnv) return fromEnv;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const host = location.hostname || "localhost";
  return `${proto}://${host}:2567`;
}

export function getRoom(): Room | null {
  return room;
}

export function getSessionId(): string | null {
  return room?.sessionId ?? null;
}

export async function connectArena(name: string): Promise<Room | null> {
  if (room || connecting) return room; // déjà connecté / en cours
  connecting = true;
  try {
    const client = new Client(endpoint());
    room = await client.joinOrCreate("arena", { name });
    room.onError((code, message) => console.warn("[net] erreur room:", code, message));
    room.onLeave(() => {
      console.log("[net] quitté l'arène");
      room = null;
    });
    console.log("[net] rejoint l'arène —", room.sessionId);
    return room;
  } catch (err) {
    // ex: salle pleine (5e joueur) ou serveur down
    console.warn("[net] connexion impossible:", err);
    room = null;
    return null;
  } finally {
    connecting = false;
  }
}

export function sendPos(x: number, z: number, aim: number): void {
  room?.send("pos", { x, z, aim });
}
