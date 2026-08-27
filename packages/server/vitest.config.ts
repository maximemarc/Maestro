import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /* Logique pure : aucun DOM nécessaire, et l'environnement node est le seul
       où `node:sqlite` et le système de fichiers se comportent normalement. */
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.ts'],
  },
});
