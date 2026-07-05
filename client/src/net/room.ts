// ============================================================
//  Couche réseau client (Colyseus) — Jalon 1 : présence
//  Rôle : se connecter à l'arène partagée, envoyer sa position,
//  exposer l'état de la room. Le RENDU des joueurs distants est
//  fait dans game.js (qui possède THREE + la scène).
// ============================================================
import { Client, Room } from "colyseus.js";

let client: Client | null = null;
let room: Room | null = null;
let connecting = false;
// callback rendu (game.js) appelé quand un AUTRE joueur tire / lance un objet
let shotCb: ((d: any) => void) | null = null;

// Métadonnées d'une partie affichées dans la liste (lobby), avant de rejoindre.
export type PartyInfo = {
  roomId: string;
  clients: number;
  maxClients: number;
  partyName: string;
  host: string;
  density: number;
  bossDelay: number;
};

function endpoint(): string {
  // Optionnel : forcer une URL via VITE_SERVER_URL.
  const fromEnv = (import.meta as any).env?.VITE_SERVER_URL;
  if (fromEnv) return fromEnv;
  // Prod (https) : le jeu est servi PAR le serveur -> même origine, pas de port.
  if (location.protocol === "https:") return `wss://${location.host}`;
  // Dev local : client sur :5173, serveur Colyseus sur :2567.
  return `ws://${location.hostname || "localhost"}:2567`;
}

function getClient(): Client {
  if (!client) client = new Client(endpoint());
  return client;
}

export function getRoom(): Room | null {
  return room;
}

export function getSessionId(): string | null {
  return room?.sessionId ?? null;
}

// Branche les écouteurs communs à toute room rejointe (création OU jonction).
function wireRoom(r: Room): void {
  room = r;
  // projectiles cosmétiques diffusés par les autres joueurs
  r.onMessage("shot", (d: any) => shotCb?.(d));
  r.onError((code, message) => console.warn("[net] erreur room:", code, message));
  r.onLeave(() => {
    console.log("[net] quitté l'arène");
    room = null;
  });
  console.log("[net] connecté à l'arène —", r.sessionId);
}

// Liste les parties en cours (metadata + effectif). Vide si serveur injoignable.
export async function listArenas(): Promise<PartyInfo[]> {
  try {
    const rooms = await getClient().getAvailableRooms("arena");
    return rooms.map((r: any) => ({
      roomId: r.roomId,
      clients: r.clients ?? 0,
      maxClients: r.maxClients ?? 4,
      partyName: r.metadata?.partyName ?? "Partie",
      host: r.metadata?.host ?? "?",
      density: r.metadata?.density ?? 1,
      bossDelay: r.metadata?.bossDelay ?? 300,
    }));
  } catch (err) {
    console.warn("[net] liste des parties indisponible:", err);
    return [];
  }
}

// CRÉER une partie : l'hôte définit les paramètres (density / bossDelay / nom).
export async function createArena(
  name: string,
  partyName: string,
  opts?: { density?: number; bossDelay?: number }
): Promise<Room | null> {
  if (room || connecting) return room;
  connecting = true;
  try {
    const r = await getClient().create("arena", { name, partyName, ...opts });
    wireRoom(r);
    return r;
  } catch (err) {
    console.warn("[net] création impossible:", err);
    room = null;
    return null;
  } finally {
    connecting = false;
  }
}

// REJOINDRE une partie existante : on n'envoie QUE son pseudo.
// Les paramètres appartiennent à l'hôte (onCreate ne tourne pas ici) -> ignorés.
export async function joinArenaById(roomId: string, name: string): Promise<Room | null> {
  if (room || connecting) return room;
  connecting = true;
  try {
    const r = await getClient().joinById(roomId, { name });
    wireRoom(r);
    return r;
  } catch (err) {
    // ex : partie pleine (4/4) ou déjà terminée entre-temps
    console.warn("[net] jonction impossible:", err);
    room = null;
    return null;
  } finally {
    connecting = false;
  }
}

// Quitte la partie (retour au menu) -> libère la place / dispose la room si vide.
export function leaveArena(): void {
  room?.leave();
  room = null;
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
