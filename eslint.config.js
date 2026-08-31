/**
 * Configuration ESLint (format « flat », ESLint 9).
 *
 * Trois familles de règles, choisies pour ce qu'elles attrapent réellement ici :
 *
 * - typescript-eslint : les imports morts et les types inutiles, qui
 *   s'accumulent dès qu'on découpe un fichier ;
 * - react-hooks : les dépendances d'effets et les appels conditionnels, la
 *   source des boucles de rendu que ce projet a déjà connues (zustand v5) ;
 * - jsx-a11y : les libellés non associés, les éléments cliquables sans rôle,
 *   les images sans alternative. L'audit design avait trouvé ces défauts à la
 *   main ; un linter les trouve à chaque commit.
 */
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import globals from 'globals';

export default tseslint.config(
  {
    /*
     * Les worktrees git vivent sous `.claude/worktrees/` : ce sont des copies
     * complètes du dépôt, pas des sources de celui-ci.
     *
     * Sans cette exclusion, `eslint .` analyse chaque fichier autant de fois
     * qu'il y a de worktrees ouverts — et il l'analyse mal : les motifs `files`
     * sont ancrés à la racine, donc le `scripts/` d'un worktree imbriqué ne
     * reçoit pas les globales Node et remonte en « process is not defined ».
     * Trois worktrees suffisaient à produire 140 erreurs qui n'existaient nulle
     * part dans le code, et qui bloquaient tout commit.
     *
     * Chaque worktree a sa propre configuration et se linte lui-même : rien
     * n'est perdu ici.
     */
    ignores: ['**/dist/**', '**/node_modules/**', 'packages/web/dist/**', '.claude/worktrees/**'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  /*
   * Le service worker ne tourne ni dans la page ni dans Node : son contexte
   * global est `self`, un ServiceWorkerGlobalScope. Sans cette déclaration,
   * chaque ligne du fichier remonte en « self is not defined ».
   */
  {
    files: ['packages/web/public/sw.js'],
    languageOptions: { globals: { ...globals.serviceworker } },
  },

  {
    files: ['packages/web/src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: {
      'react-hooks': reactHooks,
      'jsx-a11y': jsxA11y,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,

      /* Un import ou une variable morte est une trace de refactorisation
         inachevée. Le préfixe « _ » reste la porte de sortie explicite. */
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],

      /* Les onglets de la fiche agent sont des boutons qui changent l'état de
         la page, pas un vrai widget « tablist » : la règle demanderait
         aria-controls et la gestion des flèches pour un gain nul ici. */
      'jsx-a11y/no-noninteractive-element-to-interactive-role': 'off',
    },
  },

  {
    files: ['packages/server/**/*.ts', 'packages/shared/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },

  {
    /* Le pont stdio est en JavaScript volontairement : un client MCP tiers le
       lance avec `node`, sans tsx ni build. Il a donc besoin des globales Node
       comme le reste du serveur. */
    files: ['packages/server/bin/**/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },

  {
    files: ['**/*.config.{js,ts}', 'scripts/**/*.{js,mjs}'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
);
