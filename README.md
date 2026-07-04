# Gamestorming — Horde Survivor

Jeu de survie type *horde survivor* en **3D** (Three.js), **co-op multijoueur** (jusqu'à 4 joueurs) avec serveur autoritaire (Colyseus).

**🎮 En ligne : https://gamestorming.fly.dev**

## Concept

- Vue 3D iso, personnage (barbare) qui court, **compagnon volant** qui tire automatiquement l'ennemi le plus proche.
- **Co-op temps réel** : les joueurs affrontent la **même horde** (ennemis, score et kills partagés, boss commun). Flèches de bord indiquant les coéquipiers hors champ.
- **Monde infini** généré par chunks : plus tu avances, plus le monde se génère.
- **Loot au sol** : armes (qui montent en niveau), buffs (bouclier, vitesse, soin, frénésie), objets actifs visés à la souris (bombe, laser, ricochet — 3 slots).
- **Boss** : après un délai réglable (par l'hôte), un boss géant apparaît.
- Solo jouable en repli automatique si le serveur est injoignable.

## Architecture

Monorepo (npm workspaces) :

- **`client/`** — Three.js + Vite. Le jeu ; la simulation locale + le rendu + la couche réseau (`src/net/room.ts`).
- **`server/`** — Colyseus + Node/TypeScript. Horde **autoritaire** (spawn, IA, dégâts, boss), paramètres (densité, délai boss) définis par l'hôte.

En prod, le serveur sert **aussi** le jeu en statique → une seule URL sert le jeu et le WebSocket.

## Lancer en local

```bash
npm install
npm run dev        # client sur :5173 + serveur Colyseus sur :2567
```

Puis ouvrir **http://localhost:5173** (deux onglets pour tester le co-op).

## Contrôles

- **WASD / flèches** : déplacement (ZQSD sur AZERTY)
- **1 / 2 / 3** ou **clic sur un slot** : armer un objet, puis **clic au sol** pour viser
- **M** : son · **P** : pause · **B** (local) : boss immédiat
- Curseurs **densité d'ennemis** et **délai boss** au menu (visibles en local uniquement, outils de test)

## Déploiement

Auto : **`git push` sur `main`** → GitHub Actions → `flyctl deploy` sur Fly.io. Voir `DEPLOY.md`.

## Assets

- `client/public/assets/Barbarian.glb` — personnage low-poly, KayKit (Kay Lousberg), licence **CC0**.

## Stack

Three.js (r160) · Colyseus 0.15 · Vite · Fly.io · GitHub Actions.
