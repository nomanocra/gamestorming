# Déploiement

Tout tourne sur **un seul host : Fly.io** (app `gamestorming`). Le serveur Colyseus
sert à la fois le jeu (statique) et le WebSocket → une seule URL :
**https://gamestorming.fly.dev**.

## Déploiement automatique (normal)

**`git push` sur `main`** suffit :

1. GitHub Actions (`.github/workflows/fly-deploy.yml`) se déclenche
2. il lance `flyctl deploy` avec le secret `FLY_API_TOKEN`
3. Fly build l'image (`server/Dockerfile` : build client Vite + serveur, l'image
   finale sert `./public` + le WebSocket) et déploie

Suivre un déploiement : `gh run list` ou l'onglet **Actions** du repo.

## Déploiement manuel (dépannage / test rapide)

Depuis la racine, avec `flyctl` connecté (`flyctl auth login`) :

```bash
flyctl deploy          # utilise ./fly.toml (app gamestorming, région cdg)
```

⚠️ Le manuel déploie tes fichiers **locaux** (même non commités). Pour la prod, préfère le push.

## Config

- **`fly.toml`** (racine) : app, région Paris (`cdg`), `http_service` (wss, veille auto).
- **`server/Dockerfile`** : multi-stage, contexte = racine du repo.
- Le serveur écoute sur `process.env.PORT` (Fly l'injecte).
- Machines en **scale-to-zero** (`min_machines_running = 0`) : coût quasi nul au repos,
  cold-start ~qq secondes au réveil du 1er joueur.

## Coût

Fly, usage réel : **~0 $** tant que personne ne joue (veille auto). Suivi : dashboard Fly → **Billing → Cost Explorer**.

## Secret CI (une fois)

Le workflow a besoin du secret `FLY_API_TOKEN` :

```bash
flyctl tokens create deploy | gh secret set FLY_API_TOKEN -R nomanocra/gamestorming
```
