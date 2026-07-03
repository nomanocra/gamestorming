# Plan d'action — Multijoueur (Horde Survivor)

> Objectif final : co-op temps réel 4 joueurs, serveur autoritaire.
> Ce document est la feuille de route. On avance jalon par jalon.

## Avancement
- ✅ **Jalon 0** — fondations (workspaces, git, TS) — *fait, commit 714ada8*
- ✅ **Jalon 1** — présence 4 joueurs — *fait & validé end-to-end, commit 714ada8*
- 🟡 **Jalon 2** — déploiement — *config prête (Docker/Fly/Vercel + DEPLOY.md) ; push = comptes utilisateur*
- ⬜ **Jalon 3** — auth & progression (Supabase)
- ⬜ **Jalon 4** — co-op réel (horde autoritaire) ← prochaine grosse étape
- ⬜ **Jalon 5** — bandwidth & scaling (Redis)

## Hypothèses de départ (à confirmer)

Ces choix ont été pris par défaut (questions restées sans réponse) — corrigeables :

1. **Jalon 1 = présence seulement** : les joueurs se connectent à la même room et
   se **voient bouger**. Les ennemis ne sont PAS encore synchronisés (chacun garde
   sa horde locale). But : valider toute la stack réseau sans le netcode dur.
2. **TypeScript + Vite** adoptés maintenant (socle propre, sim isomorphe).
3. **Local d'abord** : serveur sur `localhost`, déploiement au Jalon 2.

## Stack cible

| Couche            | Techno                                    |
|-------------------|-------------------------------------------|
| Frontend / rendu  | Three.js + TypeScript (Vite)              |
| Temps réel        | Colyseus + Node.js (TypeScript)           |
| Sim partagée      | Module TS isomorphe (client **et** serveur) |
| Auth / DB         | Supabase (Postgres) — plus tard (Jalon 3) |
| Scaling           | Redis multi-process — plus tard (Jalon 5) |

## Scope MVP (rappel de ta demande)

- On se connecte à l'URL → on rejoint **la même instance**.  → `joinOrCreate("arena")`
- **Limité à 4 joueurs**.                                     → `maxClients = 4`
- Tous déconnectés → l'instance est tuée.                     → `autoDispose = true` (natif)

Les 3 sont natifs Colyseus : quasi zéro code pour le comportement de room lui-même.

---

## Structure du repo cible

```
game/
├─ package.json            # npm workspaces: client, server, shared
├─ shared/                 # ── LE module isomorphe (client + serveur) ──
│  └─ src/
│     ├─ state.ts          # types d'état (Player, Arena…)
│     └─ tick.ts           # sim pure: tick(state, inputs) -> state (zéro Three.js)
├─ client/                 # Vite + TS + Three.js
│  ├─ index.html
│  ├─ vite.config.ts
│  ├─ assets/Barbarian.glb
│  └─ src/
│     ├─ main.ts           # bootstrap + boucle de rendu
│     ├─ render/           # Three.js — LIT l'état, ne le possède pas
│     └─ net/room.ts       # client Colyseus: connect / joinOrCreate / sync
└─ server/                 # Colyseus + Node + TS
   └─ src/
      ├─ index.ts          # bootstrap serveur Colyseus (port 2567)
      ├─ rooms/ArenaRoom.ts# maxClients=4, onJoin/onLeave/onMessage
      └─ schema/ArenaState.ts # @colyseus/schema: MapSchema<Player>
```

---

## JALON 0 — Fondations (setup)

- [ ] `git init` + `.gitignore` (node_modules, dist)
- [ ] npm workspaces : `client/`, `server/`, `shared/`
- [ ] TS config partagée
- **Fin de jalon** : `npm run dev` lance client + serveur en parallèle.

## JALON 1 — Présence 4 joueurs (le cœur de ta demande)

### Client
- [ ] Migrer `index.html` actuel dans `client/` sous Vite + TS (solo doit remarcher)
- [ ] Extraire la position/rotation du joueur local dans un état propre
- [ ] `net/room.ts` : `client.joinOrCreate("arena")`, envoie la position ~15-20 Hz
- [ ] Écoute l'état room : instancie/déplace un avatar par joueur distant
      (réutiliser `Barbarian.glb` ou capsules simples)
- [ ] UI : "salle pleine" si connexion refusée (5ᵉ joueur), "déconnecté" si drop

### Serveur
- [ ] `ArenaState` : `MapSchema<Player>` (id, x, z, rot, name)
- [ ] `ArenaRoom` : `maxClients = 4`
- [ ] `onJoin` → ajoute au state ; `onLeave` → retire ; `autoDispose` tue la room vide
- [ ] `onMessage("pos", …)` → met à jour la position du joueur (relayé via le state)
- [ ] Logs : join / leave / room disposed

### Simplification assumée
Pour ce jalon, le client **envoie sa position** (pas encore de mouvement
autoritaire serveur ni de prédiction). On passe en input-authoritative au Jalon 4.

### Critères d'acceptation
- [ ] Ouvrir l'app dans 4 onglets → 4 avatars se déplacent en temps réel partout
- [ ] 5ᵉ connexion → refusée proprement ("salle pleine")
- [ ] Fermer tous les onglets → le serveur logue "room disposed"

---

## JALON 2 — Déploiement vraie URL
- [ ] Client → Vercel (statique, comme le solo)
- [ ] Serveur Colyseus → Fly.io ou Railway (free tier / ~5 $/mois)
- [ ] Client pointe vers l'URL wss:// de prod (variable d'env)
- **Fin** : deux personnes sur des machines différentes jouent ensemble via l'URL.

## JALON 3 — Auth & progression
- [ ] Supabase Auth (login) ; `room.onAuth(token)` vérifie le JWT côté serveur
- [ ] Table Postgres progression/profil ; pseudo persistant

## JALON 4 — Co-op réel (netcode dur) — la vraie valeur
- [ ] Sim de la **horde côté serveur** (autoritaire), via le module `shared/`
- [ ] Client envoie des **inputs** (plus la position) → prédiction locale
- [ ] Réconciliation + interpolation des entités distantes
- [ ] Ennemis / HP / score **partagés** entre les 4 joueurs

## JALON 5 — Bandwidth & scaling
- [ ] Interest management (`@colyseus/schema` `StateView`) pour des centaines d'entités
- [ ] Redis presence + multi-process quand un serveur sature

---

## Principe directeur
Le module `shared/` (état + tick, **sans** Three.js) est le socle : il tournera
à l'identique sur le serveur (autorité) et sur le client (prédiction). Tout le
reste se branche autour. On construit le **fun d'abord** (Jalons 1–4), l'infra
scalable **en dernier** (Jalon 5), et idéalement financée après signature d'un
publisher.
