import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4521,
    proxy: {
      '/api': { target: 'http://localhost:4520', changeOrigin: true },
      '/ws': { target: 'ws://localhost:4520', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        /**
         * Dépendances séparées du code applicatif.
         *
         * Compromis mesuré sur ce projet :
         * - sans ce découpage, le premier écran pèse 116 ko gzip ;
         * - avec, il pèse 127 ko, mais 99 ko de ce total (React et
         *   l'iconographie) restent en cache d'un déploiement au suivant.
         *
         * Onze kilo-octets de plus à la première visite contre 99 économisés à
         * chaque redéploiement : le compte est favorable dès la deuxième
         * ouverture. Pour une installation purement locale, où le cache
         * importe peu, retirer ce bloc est un choix défendable.
         *
         * Le poids de l'iconographie est connu et assumé : 121 ko brut, 27 ko
         * gzip pour une quarantaine d'icônes. Phosphor choisit la graisse à
         * l'exécution (prop `weight`), donc les six graisses de chaque icône
         * sont dans le paquet et aucun élagage ne peut les retirer.
         */
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('@phosphor-icons')) return 'icons';
          if (id.includes('react-dom') || id.includes('/react/') || id.includes('react-router')) {
            return 'react';
          }
          return undefined;
        },
      },
    },
  },
});
