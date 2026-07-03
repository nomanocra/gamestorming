# Déploiement

Architecture : **client statique sur Vercel** + **serveur Colyseus sur Fly.io**.

> ⚠️ Les étapes `login`/`deploy` demandent TES comptes (je ne peux pas les créer).
> Tape-les toi-même dans le terminal (préfixe `! ` dans Claude Code pour les exécuter ici).

## 1. Serveur Colyseus → Fly.io

Prérequis : compte Fly.io + `flyctl` installé (`brew install flyctl`).

```bash
cd server
fly auth login                 # ouvre le navigateur
fly launch --no-deploy         # détecte le Dockerfile + fly.toml (change le nom d'app si pris)
fly deploy
```

À la fin, note l'URL publique, ex : `https://horde-survivor-server.fly.dev`.
Le client s'y connectera en **wss://** (le `force_https` du fly.toml s'en charge).

Vérif : `curl https://<ton-app>.fly.dev/` doit répondre `Horde Survivor — serveur Colyseus OK`.

## 2. Client → Vercel

Prérequis : compte Vercel + `vercel` CLI (`npm i -g vercel`).

```bash
cd client
vercel                         # login + 1er déploiement (preview)
```

Dans le dashboard Vercel du projet (ou au prompt CLI) :
- **Root Directory** = `client`
- **Framework** = Vite (auto-détecté)
- **Variable d'environnement** : `VITE_SERVER_URL = wss://<ton-app>.fly.dev`
  (⚠️ variable de *build* : re-déploie après l'avoir ajoutée)

Puis en prod :
```bash
vercel --prod
```

## 3. Comment ça se relie

- Le client lit `VITE_SERVER_URL` (voir `client/src/net/room.ts`). Absente → il tente
  `ws://<hostname>:2567` (pratique en local, inutile en prod).
- CORS est déjà activé côté serveur (`app.use(cors())`) pour le matchmaking HTTP.

## Coûts (ordre de grandeur, prototype)

- **Vercel** : gratuit (statique).
- **Fly.io** : ~gratuit au repos (`min_machines_running = 0`), quelques $/mois en usage.
  Monte `memory` dans `fly.toml` quand la horde deviendra autoritaire (Jalon 4).

## Local (rappel)

```bash
npm run dev   # client :5173 + serveur :2567
```
