/**
 * Catalogue de serveurs MCP prêts à déclarer.
 *
 * Maestro savait déjà déclarer n'importe quel serveur MCP ; il fallait encore
 * connaître son nom de paquet, ses arguments et ses variables d'environnement.
 * Ce catalogue supprime cette étape pour les serveurs les plus utiles — c'est
 * ce qui apporte à Maestro le contrôle du navigateur, la recherche web et
 * l'extraction de page, sans écrire une ligne de code.
 *
 * 🔒 Aucune clé n'est stockée ici. Un preset déclare les variables d'environnement
 * qu'un serveur attend et ce à quoi elles servent ; c'est l'utilisateur qui les
 * renseigne à l'installation, et le registre les masque ensuite à la lecture.
 *
 * Les commandes ont été vérifiées sur les registres npm et PyPI le 28/08/2026.
 * Un paquet amont peut disparaître ou changer d'organisation : `mcpPresets()`
 * ne promet pas qu'un serveur fonctionne, seulement que sa déclaration est
 * celle publiée par son auteur à cette date.
 */

import type { McpPreset } from '@maestro/shared';

/**
 * `-y` sur chaque invocation npx.
 *
 * Sans lui, npx demande confirmation avant d'installer un paquet absent du
 * cache — sur un serveur MCP lancé en sous-processus, personne ne voit la
 * question et la session reste bloquée jusqu'au délai d'attente.
 */
const PRESETS: McpPreset[] = [
  {
    slug: 'playwright',
    name: 'Playwright',
    description:
      "Pilote un vrai navigateur : navigation, clic, saisie, capture d'écran, lecture de l'arbre d'accessibilité.",
    category: 'navigateur',
    runtime: 'npx',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
    envKeys: [],
    grants: 'automatisation complète du navigateur et analyse visuelle de page',
    homepage: 'https://github.com/microsoft/playwright-mcp',
  },
  {
    slug: 'puppeteer',
    name: 'Puppeteer',
    description: 'Navigateur sans interface : capture, extraction de contenu, exécution de script.',
    category: 'navigateur',
    runtime: 'npx',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-puppeteer'],
    envKeys: [],
    grants: 'navigation programmée et captures, plus léger que Playwright',
    homepage: 'https://github.com/modelcontextprotocol/servers',
  },
  {
    slug: 'browserbase',
    name: 'Browserbase',
    description: 'Navigateur exécuté dans le nuage — utile quand la machine n’a pas d’affichage.',
    category: 'navigateur',
    runtime: 'npx',
    command: 'npx',
    args: ['-y', '@browserbasehq/mcp'],
    envKeys: [
      { key: 'BROWSERBASE_API_KEY', hint: 'Clé du compte Browserbase.', required: true },
      { key: 'BROWSERBASE_PROJECT_ID', hint: 'Identifiant du projet.', required: true },
    ],
    grants: 'navigateur distant, sans dépendance graphique locale',
    homepage: 'https://github.com/browserbase/mcp-server-browserbase',
  },
  {
    slug: 'fetch',
    name: 'Fetch',
    description: 'Récupère une page web et la convertit en markdown lisible par un modèle.',
    category: 'web',
    runtime: 'uvx',
    command: 'uvx',
    args: ['mcp-server-fetch'],
    envKeys: [],
    grants: 'extraction de page, sans navigateur à installer',
    homepage: 'https://github.com/modelcontextprotocol/servers',
  },
  {
    slug: 'brave-search',
    name: 'Brave Search',
    description: 'Recherche web et locale via l’API Brave.',
    category: 'web',
    runtime: 'npx',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    envKeys: [
      {
        key: 'BRAVE_API_KEY',
        hint: 'Clé de l’API Brave Search (offre gratuite disponible).',
        required: true,
      },
    ],
    grants: 'recherche web',
    homepage: 'https://github.com/modelcontextprotocol/servers',
  },
  {
    slug: 'firecrawl',
    name: 'Firecrawl',
    description: 'Moissonnage de site : parcours de pages, extraction structurée, recherche.',
    category: 'web',
    runtime: 'npx',
    command: 'npx',
    args: ['-y', 'firecrawl-mcp'],
    envKeys: [{ key: 'FIRECRAWL_API_KEY', hint: 'Clé du compte Firecrawl.', required: true }],
    grants: 'extraction à l’échelle d’un site entier',
    homepage: 'https://github.com/firecrawl/firecrawl-mcp-server',
  },
  {
    slug: 'context7',
    name: 'Context7',
    description: 'Documentation à jour d’une bibliothèque, injectée au bon moment.',
    category: 'développement',
    runtime: 'npx',
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp'],
    envKeys: [],
    grants: 'documentation de bibliothèque à jour, contre les API inventées',
    homepage: 'https://github.com/upstash/context7',
  },
  {
    slug: 'github',
    name: 'GitHub',
    description: 'Dépôts, issues, pull requests et recherche de code.',
    category: 'développement',
    runtime: 'npx',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    envKeys: [
      {
        key: 'GITHUB_PERSONAL_ACCESS_TOKEN',
        hint: 'Jeton personnel, au périmètre le plus étroit possible.',
        required: true,
      },
    ],
    grants: 'lecture et écriture sur GitHub',
    homepage: 'https://github.com/modelcontextprotocol/servers',
  },
  {
    slug: 'filesystem',
    name: 'Système de fichiers',
    description:
      'Accès borné à des répertoires désignés — utile pour ouvrir une zone hors du workspace.',
    category: 'fichiers',
    runtime: 'npx',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/chemin/a/autoriser'],
    envKeys: [],
    grants: 'lecture et écriture dans les seuls répertoires passés en argument',
    homepage: 'https://github.com/modelcontextprotocol/servers',
  },
  {
    slug: 'sequential-thinking',
    name: 'Raisonnement séquentiel',
    description: 'Décompose un problème en étapes révisables.',
    category: 'raisonnement',
    runtime: 'npx',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    envKeys: [],
    grants: 'raisonnement structuré sur les problèmes longs',
    homepage: 'https://github.com/modelcontextprotocol/servers',
  },
  {
    slug: 'memory',
    name: 'Graphe de connaissances',
    description: 'Mémoire en graphe d’entités et de relations, distincte du MEMORY.md de l’agent.',
    category: 'raisonnement',
    runtime: 'npx',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    envKeys: [],
    grants: 'mémoire relationnelle interrogeable',
    homepage: 'https://github.com/modelcontextprotocol/servers',
  },
];

export function mcpPresets(): McpPreset[] {
  return PRESETS;
}

export function findMcpPreset(slug: string): McpPreset | null {
  return PRESETS.find((p) => p.slug === slug) ?? null;
}

/**
 * Traduit un preset en déclaration de serveur.
 *
 * Les variables d'environnement fournies sont filtrées sur celles que le preset
 * déclare : recopier une carte libre ferait entrer dans la configuration du
 * serveur des secrets qui n'ont rien à y faire, et qu'on ne saurait plus
 * expliquer six mois plus tard.
 */
export function presetToServerInput(
  preset: McpPreset,
  opts: { env?: Record<string, string>; args?: string[] } = {},
) {
  const declared = new Set(preset.envKeys.map((k) => k.key));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(opts.env ?? {})) {
    if (declared.has(key) && value.trim()) env[key] = value;
  }
  return {
    slug: preset.slug,
    name: preset.name,
    description: preset.description,
    kind: 'external' as const,
    enabled: true,
    transport: 'stdio' as const,
    command: preset.command,
    args: opts.args && opts.args.length > 0 ? opts.args : preset.args,
    env,
    url: null,
    headers: {},
    tools: [],
  };
}

/** Variables requises qu'un preset attend et qui n'ont pas été fournies. */
export function missingRequiredEnv(preset: McpPreset, env: Record<string, string>): string[] {
  return preset.envKeys.filter((k) => k.required && !(env[k.key] ?? '').trim()).map((k) => k.key);
}
