# Gamestorming — Horde Survivor (prototype)

Prototype d'un jeu de survie type *horde survivor* en **3D isométrique** (Three.js) : low-poly, éclairage soigné, bloom néon.

## Concept

- Vue 3D iso, personnage (barbare) qui court, **compagnon volant** qui tire automatiquement l'ennemi le plus proche.
- **Monde infini** généré par chunks (façon Minecraft) : plus tu avances, plus le monde se génère.
- **Loot au sol** : armes (qui montent en niveau si on les recupère), buffs instantanés (bouclier, vitesse, soin, frénésie), objets actifs visés à la souris (bombe, laser, ricochet — 3 slots).
- **Boss** : à la fin d'un timer réglable, les spawns s'arrêtent puis un boss géant apparaît et canarde le joueur.
- **Score + classement** (local, ou mondial via Supabase — voir `LEADERBOARD` dans `index.html`).

## Lancer le jeu

La 3D charge Three.js en modules ES → il faut un petit serveur local (le double-clic sur le fichier ne suffit pas) :

```bash
python3 -m http.server 8000
```

Puis ouvrir **http://localhost:8000/index.html**.

## Contrôles

- **WASD / flèches** : déplacement (ZQSD sur AZERTY — basé sur la position physique des touches)
- **1 / 2 / 3** ou **clic sur un slot** : armer un objet, puis **clic au sol** pour viser
- **M** : son · **P** : pause · **B** : faire apparaître le boss immédiatement

## Assets

- `assets/Barbarian.glb` — personnage low-poly, KayKit (Kay Lousberg), licence **CC0**.

## Stack

Three.js (r160), rendu WebGL + post-processing (UnrealBloom), aucune étape de build — un seul fichier `index.html`.
