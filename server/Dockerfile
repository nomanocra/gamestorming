# Image de prod : build le CLIENT (Vite) + le SERVEUR (Colyseus), puis le
# serveur sert le jeu en statique. Contexte de build = racine du repo.

# ---- 1) build client (Vite) ----
FROM node:20-alpine AS client
WORKDIR /app
COPY package.json package-lock.json ./
COPY client/package.json ./client/package.json
COPY server/package.json ./server/package.json
RUN npm ci
COPY client ./client
RUN npm run build -w client   # -> client/dist

# ---- 2) build serveur (TS -> JS) ----
FROM node:20-alpine AS server
WORKDIR /app
COPY server/package.json ./
RUN npm install
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build          # -> dist

# ---- 3) image finale ----
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=2567
COPY server/package.json ./
RUN npm install --omit=dev
COPY --from=server /app/dist ./dist
COPY --from=client /app/client/dist ./public
EXPOSE 2567
CMD ["node", "dist/index.js"]
