import { createServer } from "http";
import express from "express";
import cors from "cors";
import { Server } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { ArenaRoom } from "./rooms/ArenaRoom";

const port = Number(process.env.PORT ?? 2567);

const app = express();
app.use(cors()); // autorise le client (autre origine/port) à faire le matchmaking HTTP
app.get("/", (_req, res) => {
  res.send("Horde Survivor — serveur Colyseus OK");
});

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
