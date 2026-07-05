// ============================================================
//  Couche réseau client (Colyseus) — Jalon 1 : présence
//  Rôle : se connecter à l'arène partagée, envoyer sa position,
//  exposer l'état de la room. Le RENDU des joueurs distants est
//  fait dans game.js (qui possède THREE + la scène).
// ============================================================
import { Client, Room } from "colyseus.js";

let room: Room | null = null;
let connecting = false;
// callback rendu (game.js) appelé quand un AUTRE joueur tire / lance un objet
let shotCb: ((d: any) => void) | null = null;

function endpoint(): string {
  // Optionnel : forcer une URL via VITE_SERVER_URL.
  const fromEnv = (import.meta as any).env?.VITE_SERVER_URL;
  if (fromEnv) return fromEnv;
  // Prod (https) : le jeu est servi PAR le serveur -> même origine, pas de port.
  if (location.protocol === "https:") return `wss://${location.host}`;
  // Dev local : client sur :5173, serveur Colyseus sur :2567.
  return `ws://${location.hostname || "localhost"}:2567`;
}

export function getRoom(): Room | null {
  return room;
}

export function getSessionId(): string | null {
  return room?.sessionId ?? null;
}

export async function connectArena(
  name: string,
  opts?: { density?: number; bossDelay?: number }
): Promise<Room | null> {
  if (room || connecting) return room; // déjà connecté / en cours
  connecting = true;
  try {
    const client = new Client(endpoint());
    // density/bossDelay ne comptent que pour le 1er joueur (création de la room)
    room = await client.joinOrCreate("arena", { name, ...opts });
    // projectiles cosmétiques diffusés par les autres joueurs
    room.onMessage("shot", (d: any) => shotCb?.(d));
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

export function sendPos(x: number, z: number, aim: number, face: number): void {
  room?.send("pos", { x, z, aim, face });
}

// Diffuse un projectile (tir/objet) aux autres joueurs — purement cosmétique.
export function sendShot(d: any): void {
  room?.send("shot", d);
}

// Enregistre le rendu des projectiles distants (game.js possède THREE + la scène).
export function onShot(cb: (d: any) => void): void {
  shotCb = cb;
}

// Signale au serveur qu'une balle/objet a touché l'ennemi `id`.
// Le serveur reste autoritaire sur les hp et la mort.
export function sendHit(id: string, dmg: number): void {
  room?.send("hit", { id, dmg });
}

// Règle la densité de la horde (outil de test). Room-level : le dernier gagne.
export function sendDensity(d: number): void {
  room?.send("density", { d });
}
