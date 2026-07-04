import { createServer } from "http";
import path from "path";
import express from "express";
import cors from "cors";
import { Server } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { ArenaRoom } from "./rooms/ArenaRoom";

const port = Number(process.env.PORT ?? 2567);

const app = express();
app.use(cors()); // utile en dev (client :5173 -> serveur :2567) ; inoffensif en prod
// Sert le jeu (client Vite buildé, copié dans ./public par le Dockerfile).
// -> gamestorming.fly.dev sert à la fois le JEU et le WebSocket (même origine).
// Les requêtes /matchmake ne matchent aucun fichier et passent à Colyseus.
app.use(express.static(path.join(__dirname, "..", "public")));
app.get("/healthz", (_req, res) => res.send("ok"));

const gameServer = new Server({
  // Transport explicite avec heartbeat : indispensable pour détecter les
  // déconnexions BRUTALES (onglet fermé, crash réseau) et libérer la place.
  // Sans ping, une connexion morte reste comptée -> la room ne se dispose jamais.
  transport: new WebSocketTransport({
    server: createServer(app),
    pingInterval: 3000, // ping toutes les 3 s
    pingMaxRetries: 2, // 2 pings sans réponse -> client considéré parti (~6-9 s)
  }),
});
gameServer.define("arena", ArenaRoom);

gameServer.listen(port);
console.log(`[server] Colyseus en écoute sur le port ${port} (ws://localhost:${port})`);
