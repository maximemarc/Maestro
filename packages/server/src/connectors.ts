/**
 * Connecteurs de skills — import depuis des sources distantes.
 *
 * Deux connecteurs livrés :
 *  - `claudeskills` : annuaire claudeskills.info (API JSON en lecture seule) ;
 *  - `github`       : import direct d'un SKILL.md par référence.
 *
 * 🔒 Deux garde-fous non négociables ici :
 *  1. Le serveur ne contacte que des hôtes explicitement autorisés — une
 *     référence fournie par l'utilisateur ne doit pas se transformer en requête
 *     sortante arbitraire depuis la machine hôte.
 *  2. Rien n'est jamais installé sans prévisualisation : une skill est une
 *     consigne injectée dans un agent qui a accès aux outils. Le contenu doit
 *     passer sous les yeux d'un humain, la décision lui appartient.
 */
import type {
  PluginInventory,
  RemotePluginPreview,
  RemoteSkill,
  RemoteSkillPreview,
  RemoteSkillSearch,
  SkillConnector,
} from '@maestro/shared';

/** Au-delà, ce n'est plus une skill : on refuse plutôt que de tronquer. */
const MAX_CONTENT_BYTES = 512 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

const CATALOG_HOST = 'claudeskills.info';
const RAW_HOST = 'raw.githubusercontent.com';

/** Branches et chemins tentés quand le catalogue ne pointe qu'un dépôt. */
const CANDIDATE_BRANCHES = ['main', 'master'];
const CANDIDATE_PATHS = (slug: string): string[] => [
  'SKILL.md',
  `${slug}/SKILL.md`,
  `skills/${slug}/SKILL.md`,
  `.claude/skills/${slug}/SKILL.md`,
  `skills/${slug}.md`,
  `${slug}.md`,
];

const CONNECTORS: SkillConnector[] = [
  {
    id: 'claudeskills',
    name: 'Claude Skills Hub',
    description:
      "Annuaire communautaire de skills, subagents et plugins pour agents de code. Les contenus sont hébergés sur GitHub ; l'annuaire ne fait que les référencer.",
    kind: 'catalog',
    homepage: 'https://claudeskills.info/',
    hosts: [CATALOG_HOST, RAW_HOST],
    categories: [],
    types: [],
    totalItems: null,
  },
  {
    id: 'github',
    name: 'GitHub (import direct)',
    description:
      "Import d'un SKILL.md par sa référence : URL GitHub, ou owner/repo/chemin/SKILL.md. Utile quand une skill n'est pas référencée dans un annuaire.",
    kind: 'git',
    homepage: 'https://github.com/',
    hosts: [RAW_HOST],
    categories: [],
    types: [],
    totalItems: null,
  },
];

export interface CatalogSearchOptions {
  q?: string;
  category?: string;
  type?: string;
  featured?: boolean;
  sort?: 'stars' | 'newest';
  limit?: number;
  offset?: number;
}

/** Forme des entrées renvoyées par l'API du catalogue (champs utilisés). */
interface CatalogItem {
  slug?: string;
  name?: string;
  description?: string;
  category?: string;
  type?: string;
  stars?: number;
  featured?: number;
  confidence?: string;
  origin?: string;
  source?: { repo?: string; url?: string };
}

function slugify(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

export class ConnectorError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export class ConnectorRegistry {
  /** Facettes du catalogue, apprises au premier appel de /meta. */
  private catalogMeta: { categories: string[]; types: string[]; total: number } | null = null;

  list(): SkillConnector[] {
    return CONNECTORS.map((connector) =>
      connector.id === 'claudeskills' && this.catalogMeta
        ? {
            ...connector,
            categories: this.catalogMeta.categories,
            types: this.catalogMeta.types,
            totalItems: this.catalogMeta.total,
          }
        : connector,
    );
  }

  get(id: string): SkillConnector | null {
    return CONNECTORS.find((c) => c.id === id) ?? null;
  }

  /**
   * Récupère une URL après avoir vérifié que son hôte est autorisé pour ce
   * connecteur. Toute redirection hors allowlist est refusée : on ne suit pas
   * une redirection vers un hôte arbitraire.
   */
  private async fetchAllowed(url: string, connector: SkillConnector): Promise<Response> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ConnectorError(`URL invalide : ${url}`);
    }
    if (parsed.protocol !== 'https:') {
      throw new ConnectorError('Seul HTTPS est autorisé.');
    }
    if (!connector.hosts.includes(parsed.hostname)) {
      throw new ConnectorError(
        `Hôte non autorisé pour le connecteur « ${connector.name} » : ${parsed.hostname}. ` +
          `Autorisés : ${connector.hosts.join(', ')}.`,
      );
    }
    const res = await fetch(parsed.toString(), {
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: 'application/json, text/plain, */*', 'user-agent': 'maestro/0.1' },
    });
    if (res.status >= 300 && res.status < 400) {
      throw new ConnectorError(`Redirection refusée (${res.status}) : ${parsed.hostname}`);
    }
    return res;
  }

  private async loadCatalogMeta(connector: SkillConnector): Promise<void> {
    if (this.catalogMeta) return;
    try {
      const res = await this.fetchAllowed(`https://${CATALOG_HOST}/api/v1/meta`, connector);
      if (!res.ok) return;
      const meta = (await res.json()) as {
        categories?: string[];
        types?: Record<string, number>;
        total_items?: number;
      };
      this.catalogMeta = {
        // Le catalogue expose quelques valeurs parasites (ex. `["design"]`).
        categories: (meta.categories ?? []).filter((c) => /^[a-z0-9-]+$/.test(c)),
        types: Object.keys(meta.types ?? {}),
        total: meta.total_items ?? 0,
      };
    } catch {
      // Métadonnées indisponibles : la recherche reste utilisable sans facettes.
    }
  }

  async search(connectorId: string, opts: CatalogSearchOptions): Promise<RemoteSkillSearch> {
    const connector = this.get(connectorId);
    if (!connector) throw new ConnectorError(`Connecteur inconnu : ${connectorId}`);
    if (connector.kind !== 'catalog') {
      throw new ConnectorError(`Le connecteur « ${connector.name} » ne propose pas de recherche.`);
    }
    await this.loadCatalogMeta(connector);

    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const params = new URLSearchParams();
    if (opts.q) params.set('q', opts.q);
    if (opts.category) params.set('category', opts.category);
    if (opts.type) params.set('type', opts.type);
    if (opts.featured) params.set('featured', '1');
    if (opts.sort) params.set('sort', opts.sort);
    params.set('limit', String(limit));
    params.set('offset', String(Math.max(opts.offset ?? 0, 0)));

    const res = await this.fetchAllowed(
      `https://${CATALOG_HOST}/api/v1/search?${params.toString()}`,
      connector,
    );
    if (!res.ok) throw new ConnectorError(`Le catalogue a répondu ${res.status}.`);
    const payload = (await res.json()) as {
      total?: number;
      limit?: number;
      offset?: number;
      results?: CatalogItem[];
    };

    const results: RemoteSkill[] = (payload.results ?? []).map((item) => {
      const slug = item.slug ?? slugify(item.name ?? 'skill');
      return {
        connectorId,
        // Le slug suffit : la résolution du contenu repasse par l'API item.
        ref: slug,
        slug,
        name: item.name ?? slug,
        description: item.description ?? '',
        category: item.category?.trim() ? item.category : null,
        type: item.type ?? 'skill',
        stars: typeof item.stars === 'number' ? item.stars : null,
        featured: item.featured === 1,
        confidence: item.confidence ?? null,
        origin: item.origin ?? null,
        repo: item.source?.repo ?? null,
        sourceUrl: item.source?.url ?? null,
      };
    });

    return {
      total: payload.total ?? results.length,
      limit: payload.limit ?? limit,
      offset: payload.offset ?? 0,
      results,
    };
  }

  /**
   * Convertit une URL GitHub en URL de contenu brut. Renvoie null si l'URL ne
   * désigne pas un fichier (page de dépôt, arborescence…).
   */
  private toRawUrl(url: string): string | null {
    const blob = url.match(
      /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:blob|raw)\/([^/]+)\/(.+?)(?:[?#].*)?$/,
    );
    if (blob) {
      const [, owner, repo, ref, path] = blob;
      return `https://${RAW_HOST}/${owner}/${repo}/${ref}/${path}`;
    }
    if (url.startsWith(`https://${RAW_HOST}/`)) return url.split(/[?#]/)[0] ?? url;
    return null;
  }

  private repoFromUrl(url: string): { owner: string; repo: string } | null {
    const m = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/?#]+)/);
    if (!m) return null;
    const owner = m[1];
    const repo = m[2]?.replace(/\.git$/, '');
    return owner && repo ? { owner, repo } : null;
  }

  /** `owner/repo` déduit d'une URL raw.githubusercontent.com. */
  private repoSlugFromRaw(url: string): string | null {
    const m = url.match(/^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\//);
    return m?.[1] && m[2] ? `${m[1]}/${m[2]}` : null;
  }

  /**
   * Résout le manifeste d'un plugin distant. Un plugin est un dépôt : on lit son
   * `.claude-plugin/plugin.json` AVANT tout clonage, pour que la décision se
   * prenne sur pièces.
   */
  async previewPlugin(connectorId: string, ref: string): Promise<RemotePluginPreview> {
    const connector = this.get(connectorId);
    if (!connector) throw new ConnectorError(`Connecteur inconnu : ${connectorId}`);
    const trimmed = ref.trim();
    if (!trimmed) throw new ConnectorError('Référence vide.');

    let repo: string | null = null;
    let fallbackName = '';
    let fallbackDescription = '';

    if (connector.kind === 'catalog') {
      const res = await this.fetchAllowed(
        `https://${CATALOG_HOST}/api/v1/items/${encodeURIComponent(trimmed)}`,
        connector,
      );
      if (res.status === 404)
        throw new ConnectorError(`Entrée inconnue dans le catalogue : ${trimmed}`);
      if (!res.ok) throw new ConnectorError(`Le catalogue a répondu ${res.status}.`);
      const item = (await res.json()) as CatalogItem;
      repo = item.source?.repo ?? null;
      fallbackName = item.name ?? trimmed;
      fallbackDescription = item.description ?? '';
      if (!repo) {
        const parsedRepo = this.repoFromUrl(item.source?.url ?? '');
        repo = parsedRepo ? `${parsedRepo.owner}/${parsedRepo.repo}` : null;
      }
    } else {
      const cleaned = trimmed.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
      const parts = cleaned.replace(/^\/+|\/+$/g, '').split('/');
      if (!parts[0] || !parts[1]) throw new ConnectorError('Référence attendue : owner/repo');
      repo = `${parts[0]}/${parts[1]}`;
      fallbackName = parts[1];
    }
    if (!repo) throw new ConnectorError(`Dépôt introuvable pour « ${trimmed} ».`);

    const attempted: string[] = [];
    for (const branch of CANDIDATE_BRANCHES) {
      const url = `https://${RAW_HOST}/${repo}/${branch}/.claude-plugin/plugin.json`;
      attempted.push(url);
      const raw = await this.readRaw(url, connector);
      if (raw === null || raw.trim() === '') continue;
      let manifest: Record<string, unknown>;
      try {
        manifest = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        throw new ConnectorError(`Manifeste illisible (JSON invalide) : ${url}`);
      }
      const countOf = (key: string): number => {
        const value = manifest[key];
        if (Array.isArray(value)) return value.length;
        if (value && typeof value === 'object') return Object.keys(value).length;
        return 0;
      };
      const inventory: PluginInventory = {
        skills: countOf('skills'),
        agents: countOf('agents'),
        commands: countOf('commands'),
        hooks: countOf('hooks'),
        mcpServers: countOf('mcpServers'),
      };
      const author = manifest.author;
      return {
        connectorId,
        ref: trimmed,
        repo,
        cloneUrl: `https://github.com/${repo}`,
        name: typeof manifest.name === 'string' && manifest.name ? manifest.name : fallbackName,
        description:
          typeof manifest.description === 'string' && manifest.description
            ? manifest.description
            : fallbackDescription,
        version: typeof manifest.version === 'string' ? manifest.version : null,
        author:
          typeof author === 'string'
            ? author
            : author && typeof author === 'object' && 'name' in author
              ? String((author as { name: unknown }).name)
              : null,
        resolvedUrl: url,
        inventory,
        manifest: raw.trim(),
      };
    }

    throw new ConnectorError(
      `Aucun manifeste .claude-plugin/plugin.json trouvé dans ${repo}. ` +
        `Ce dépôt n'est probablement pas un plugin Claude Code.\nEssayé :\n${attempted.join('\n')}`,
    );
  }

  /** Lit une URL brute et rend son contenu, taille bornée. */
  private async readRaw(url: string, connector: SkillConnector): Promise<string | null> {
    const res = await this.fetchAllowed(url, connector);
    if (!res.ok) return null;
    const length = Number(res.headers.get('content-length') ?? '0');
    if (length > MAX_CONTENT_BYTES) {
      throw new ConnectorError(`Fichier trop volumineux (${length} octets).`);
    }
    const text = await res.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_CONTENT_BYTES) {
      throw new ConnectorError('Fichier trop volumineux.');
    }
    return text;
  }

  /**
   * Résout la référence d'une skill en contenu markdown.
   *
   * Le catalogue ne publie aucune commande d'installation : `source.url` pointe
   * soit un fichier précis, soit la racine du dépôt. Dans ce second cas on
   * essaie les emplacements conventionnels d'un SKILL.md, faute de mieux.
   */
  async preview(connectorId: string, ref: string): Promise<RemoteSkillPreview> {
    const connector = this.get(connectorId);
    if (!connector) throw new ConnectorError(`Connecteur inconnu : ${connectorId}`);
    const trimmed = ref.trim();
    if (!trimmed) throw new ConnectorError('Référence vide.');

    let slug = slugify(trimmed.split('/').pop() ?? 'skill').replace(/-?(skill|md)$/, '') || 'skill';
    let name = slug;
    let description = '';
    let componentType = 'skill';
    let repo: string | null = null;
    const attempted: string[] = [];
    let candidates: string[] = [];

    if (connector.kind === 'catalog') {
      const res = await this.fetchAllowed(
        `https://${CATALOG_HOST}/api/v1/items/${encodeURIComponent(trimmed)}`,
        connector,
      );
      if (res.status === 404)
        throw new ConnectorError(`Entrée inconnue dans le catalogue : ${trimmed}`);
      if (!res.ok) throw new ConnectorError(`Le catalogue a répondu ${res.status}.`);
      const item = (await res.json()) as CatalogItem;
      slug = item.slug ?? slug;
      name = item.name ?? slug;
      description = item.description ?? '';
      componentType = item.type ?? 'skill';
      repo = item.source?.repo ?? null;
      const sourceUrl = item.source?.url ?? '';
      const direct = this.toRawUrl(sourceUrl);
      if (direct) {
        candidates = [direct];
      } else {
        const repo = this.repoFromUrl(sourceUrl);
        if (!repo)
          throw new ConnectorError(`Source illisible pour « ${slug} » : ${sourceUrl || '(vide)'}`);
        candidates = CANDIDATE_BRANCHES.flatMap((branch) =>
          CANDIDATE_PATHS(slug).map(
            (path) => `https://${RAW_HOST}/${repo.owner}/${repo.repo}/${branch}/${path}`,
          ),
        );
      }
    } else {
      // Connecteur git : URL complète, ou owner/repo/chemin.
      const direct = trimmed.startsWith('https://') ? this.toRawUrl(trimmed) : null;
      if (direct) {
        candidates = [direct];
      } else if (trimmed.startsWith('https://')) {
        throw new ConnectorError(
          "Cette URL ne désigne pas un fichier. Donne l'URL d'un SKILL.md (lien « blob »), ou owner/repo/chemin/SKILL.md.",
        );
      } else {
        const parts = trimmed.replace(/^\/+|\/+$/g, '').split('/');
        const owner = parts[0];
        const repo = parts[1];
        const path = parts.slice(2).join('/');
        if (!owner || !repo)
          throw new ConnectorError('Référence attendue : owner/repo/chemin/SKILL.md');
        candidates = path
          ? CANDIDATE_BRANCHES.map((b) => `https://${RAW_HOST}/${owner}/${repo}/${b}/${path}`)
          : CANDIDATE_BRANCHES.flatMap((b) =>
              CANDIDATE_PATHS(slug).map((p) => `https://${RAW_HOST}/${owner}/${repo}/${b}/${p}`),
            );
      }
    }

    for (const candidate of candidates) {
      attempted.push(candidate);
      const content = await this.readRaw(candidate, connector);
      if (content === null || content.trim() === '') continue;
      const parsed = parseSkillMarkdown(content, name, description);
      return {
        connectorId,
        ref: trimmed,
        name: parsed.name,
        description: parsed.description,
        suggestedSlug: slugify(parsed.name) || slug,
        content: parsed.body,
        resolvedUrl: candidate,
        sizeBytes: Buffer.byteLength(content, 'utf8'),
        componentType,
        repo: repo ?? this.repoSlugFromRaw(candidate),
        agentDraft: parsed.agentDraft,
      };
    }

    throw new ConnectorError(
      `Aucun SKILL.md trouvé pour « ${trimmed} ». Emplacements essayés :\n` +
        attempted.slice(0, 6).join('\n') +
        (attempted.length > 6 ? `\n… (${attempted.length - 6} autres)` : '') +
        `\nUtilise le connecteur « GitHub (import direct) » avec l'URL exacte du fichier.`,
    );
  }
}

/**
 * Sépare le frontmatter du corps. Le nom et la description du fichier priment
 * sur ceux du catalogue : c'est la skill elle-même qui fait foi.
 */
function parseSkillMarkdown(
  raw: string,
  fallbackName: string,
  fallbackDescription: string,
): {
  name: string;
  description: string;
  body: string;
  agentDraft: { tools: string[]; model: string | null; color: string | null } | null;
} {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return {
      name: fallbackName,
      description: fallbackDescription,
      body: raw.trim(),
      agentDraft: null,
    };
  }
  const head = match[1] ?? '';
  const body = raw.slice(match[0].length).trim();
  const get = (key: string): string => {
    const m = head.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'));
    return m?.[1]?.trim().replace(/^["']|["']$/g, '') ?? '';
  };
  const tools = get('tools')
    .replace(/Agent\([^)]*\)/g, '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => /^[A-Za-z][\w*_]*$/.test(t));
  const model = get('model');
  const color = get('color');
  return {
    name: get('name') || fallbackName,
    description: get('description') || fallbackDescription,
    body,
    // Un frontmatter de subagent porte ces clés ; une skill n'en a aucune.
    agentDraft:
      tools.length > 0 || model || color
        ? { tools, model: model || null, color: color || null }
        : null,
  };
}
