import { defineConfig } from "vite";

// L'ancien code utilise les chemins "three/addons/..." (hérités de l'importmap CDN).
// On les redirige vers le vrai emplacement npm "three/examples/jsm/..." pour ne pas
// avoir à réécrire toutes les lignes d'import du jeu.
export default defineConfig({
  resolve: {
    alias: [{ find: /^three\/addons\//, replacement: "three/examples/jsm/" }],
  },
  server: {
    port: 5173,
    host: true,
  },
});
