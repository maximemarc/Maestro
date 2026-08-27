import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /* jsdom est nécessaire aux tests de comportement clavier (piège de focus,
       association libellé/champ) : ce sont eux qui protègent les corrections
       d'accessibilité, pas les tests de logique pure. */
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
