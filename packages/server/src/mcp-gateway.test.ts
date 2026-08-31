/**
 * Tests de la passerelle MCP.
 *
 * Ce qui doit tenir, parce que ça casse en silence et que ça ouvre un accès :
 *
 * - le périmètre d'un agent est **fermé** : une collection ou un outil hors
 *   périmètre n'est ni listé, ni appelable en devinant son nom ;
 * - un outil sous approbation humaine passe par le broker et **n'est exécuté
 *   qu'après une décision** ; sans agent identifié, Maestro n'a personne à qui
 *   la demander et refuse ;
 * - une action de contrôle ouvre sa **session externe avant** d'agir : c'est
 *   elle qui donne son parent à une délégation, et une délégation orpheline
 *   échappe à l'annulation en cascade ;
 * - le catalogue n'annonce pas d'outil RAG quand aucune base n'est accessible,
 *   ni d'outil de contrôle quand aucun agent n'est identifié.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AgentConfig, McpServerDef, McpToolDef, RagCollection, Run } from '@maestro/shared';
import type { AgentService } from './agents.ts';
import type { Bus } from './bus.ts';
import {
  GatewayError,
  callGatewayTool,
  listGatewayTools,
  resolveScope,
  type GatewayDeps,
} from './mcp-gateway.ts';
import type { RagService } from './rag.ts';

function collection(id: string, slug: string): RagCollection {
  return {
    id,
    slug,
    name: `Base ${slug}`,
    description: '',
    chunkSize: 1200,
    chunkOverlap: 150,
    documentCount: 2,
    chunkCount: 12,
    embeddedChunkCount: 12,
    staleChunkCount: 0,
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
  };
}

function customTool(overrides: Partial<McpToolDef> = {}): McpToolDef {
  return {
    name: 'lister',
    description: 'Liste les dossiers.',
    params: [
      {
        name: 'siret',
        type: 'string',
        description: 'SIRET du client.',
        required: true,
        enumValues: [],
      },
      { name: 'limite', type: 'number', description: '', required: false, enumValues: [] },
    ],
    action: {
      kind: 'http',
      method: 'GET',
      /* Port fermé sur la boucle locale : l'appel échoue en quelques
         millisecondes, là où un domaine inexistant ferait attendre le DNS. */
      urlTemplate: 'http://127.0.0.1:9/dossiers',
      headers: {},
      bodyTemplate: '',
      responsePath: '',
      timeoutMs: 15000,
    },
    requiresApproval: false,
    ...overrides,
  };
}

function customServer(overrides: Partial<McpServerDef> = {}): McpServerDef {
  return {
    id: 'srv-1',
    slug: 'crm',
    name: 'CRM interne',
    description: '',
    kind: 'custom',
    enabled: true,
    transport: null,
    command: null,
    args: [],
    env: {},
    url: null,
    headers: {},
    tools: [customTool()],
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
    ...overrides,
  };
}

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'agent-1',
    name: 'Comptabilité',
    ragCollectionIds: ['col-1'],
    mcpServerIds: ['srv-1'],
    ...overrides,
    /* Doublure : seuls les champs que la passerelle lit sont renseignés.
       Compléter les vingt autres n'apporterait aucune garantie de plus. */
  } as unknown as AgentConfig;
}

interface Harness {
  deps: GatewayDeps;
  search: ReturnType<typeof vi.fn>;
  warnings: string[];
}

function harness(
  options: {
    collections?: RagCollection[];
    servers?: McpServerDef[];
    agents?: AgentConfig[];
  } = {},
): Harness {
  const collections = options.collections ?? [
    collection('col-1', 'compta'),
    collection('col-2', 'rh'),
  ];
  const servers = options.servers ?? [customServer()];
  const agents = options.agents ?? [agent()];
  const warnings: string[] = [];

  const search = vi.fn(async () => ({ hits: [], semanticUsed: false, durationMs: 3 }));

  const deps: GatewayDeps = {
    rag: {
      list: () => collections,
      collectionsForAgent: (ids: string[]) => collections.filter((c) => ids.includes(c.id)),
      search,
    } as unknown as RagService,
    agents: {
      get: (id: string) => agents.find((a) => a.id === id) ?? null,
      list: () => agents,
    } as unknown as AgentService,
    bus: {
      log: (_level: string, _scope: string, message: string) => warnings.push(message),
    } as unknown as Bus,
    listServers: () => servers,
    version: '0.1.0',
  };

  return { deps, search, warnings };
}

/**
 * Passerelle gouvernée : celle du lot A2, avec session externe, actions de
 * contrôle et broker d'approbation.
 *
 * Les doublures enregistrent ce qui compte — le run passé au broker, le parent
 * d'une délégation — parce que c'est précisément ce qui, mal branché, ferait
 * agir un client tiers hors de portée de l'orchestrateur sans que rien ne le
 * signale.
 */
function governedHarness(options: { approval?: 'allow' | 'deny'; servers?: McpServerDef[] } = {}) {
  const base = harness({ servers: options.servers });
  const sessionRun = { id: 'run_ext_1', agentId: 'agent-1' } as unknown as Run;

  const touch = vi.fn(() => sessionRun);
  const record = vi.fn();
  /* Les doublures déclarent leurs paramètres : sans cela leur type d'appel est
     un tuple vide, et l'inspection des arguments — le cœur de ces tests — ne
     compile pas. */
  const start = vi.fn((_input: Record<string, unknown>) => ({ id: 'run_child_1' }));
  const created: { title: string; agentId: string }[] = [];
  const requestHumanApproval = vi.fn(
    async (_runId: string, _agent: AgentConfig, _tool: string, _args: unknown) => ({
      decision: options.approval ?? 'allow',
      resolvedBy: 'web',
      note: options.approval === 'deny' ? 'Refusé en test' : undefined,
    }),
  );

  const deps: GatewayDeps = {
    ...base.deps,
    control: {
      tasks: {
        create: (input: { title: string; agentId: string }) => {
          created.push(input);
          return { id: 'task-1', title: input.title, column: 'backlog' };
        },
        get: () => null,
      },
      agents: {
        ...(base.deps.agents as unknown as object),
        getByName: (name: string) =>
          name === 'Relecteur' ? ({ id: 'agent-2', name: 'Relecteur' } as AgentConfig) : null,
        list: () => [agent()],
        appendMemory: vi.fn(),
      },
      bus: base.deps.bus,
      engine: { start, waitForRun: vi.fn() },
      maxAgentDepth: () => 2,
    } as unknown as GatewayDeps['control'],
    sessions: { touch, record } as unknown as GatewayDeps['sessions'],
    approvals: { requestHumanApproval } as unknown as GatewayDeps['approvals'],
  };

  return { deps, touch, record, start, created, requestHumanApproval };
}

describe('périmètre', () => {
  it('sans en-tête d’agent, expose tout ce qui est activé', () => {
    const { deps } = harness();
    const scope = resolveScope(deps, null);
    expect(scope.agent).toBeNull();
    expect(scope.collections.map((c) => c.slug)).toEqual(['compta', 'rh']);
    expect(scope.servers.map((s) => s.slug)).toEqual(['crm']);
  });

  it('restreint au périmètre de l’agent nommé', () => {
    const { deps } = harness();
    const scope = resolveScope(deps, 'agent-1');
    expect(scope.collections.map((c) => c.slug)).toEqual(['compta']);
  });

  it('accepte le nom de l’agent, insensible à la casse', () => {
    const { deps } = harness();
    expect(resolveScope(deps, 'comptabilité').agent?.id).toBe('agent-1');
  });

  it('refuse un agent inconnu plutôt que d’ouvrir tout le périmètre', () => {
    const { deps } = harness();
    expect(() => resolveScope(deps, 'fantôme')).toThrow(GatewayError);
  });

  it('ignore un serveur maison désactivé et un serveur externe', () => {
    const { deps } = harness({
      servers: [
        customServer({ id: 'srv-1', slug: 'off', enabled: false }),
        customServer({ id: 'srv-2', slug: 'externe', kind: 'external', transport: 'stdio' }),
      ],
    });
    expect(resolveScope(deps, null).servers).toEqual([]);
  });

  it('exclut du périmètre un serveur non confié à l’agent', () => {
    const { deps } = harness({
      servers: [customServer(), customServer({ id: 'srv-9', slug: 'paie' })],
    });
    expect(resolveScope(deps, 'agent-1').servers.map((s) => s.slug)).toEqual(['crm']);
  });
});

describe('catalogue', () => {
  it('annonce les outils RAG et les outils maison préfixés du slug', () => {
    const { deps } = harness();
    const names = listGatewayTools(resolveScope(deps, null)).map((t) => t.name);
    expect(names).toEqual(['rag_collections', 'rag_search', 'crm__lister']);
  });

  it('n’annonce aucun outil RAG sans collection accessible', () => {
    const { deps } = harness({ agents: [agent({ ragCollectionIds: [] })] });
    const names = listGatewayTools(resolveScope(deps, 'agent-1')).map((t) => t.name);
    expect(names).toEqual(['crm__lister']);
  });

  it('borne l’énumération des collections à celles du périmètre', () => {
    const { deps } = harness();
    const search = listGatewayTools(resolveScope(deps, 'agent-1')).find(
      (t) => t.name === 'rag_search',
    );
    const properties = (search?.inputSchema as { properties: Record<string, { enum?: string[] }> })
      .properties;
    expect(properties.collection?.enum).toEqual(['compta']);
  });

  it('traduit les paramètres maison en JSON Schema, requis compris', () => {
    const { deps } = harness();
    const tool = listGatewayTools(resolveScope(deps, null)).find((t) => t.name === 'crm__lister');
    expect(tool?.inputSchema).toMatchObject({
      type: 'object',
      properties: { siret: { type: 'string' }, limite: { type: 'number' } },
      required: ['siret'],
      additionalProperties: false,
    });
  });

  it('signale dans la description l’outil qui exige une approbation', () => {
    const { deps } = harness({
      servers: [customServer({ tools: [customTool({ requiresApproval: true })] })],
    });
    const tool = listGatewayTools(resolveScope(deps, null)).find((t) => t.name === 'crm__lister');
    expect(tool?.description).toContain('approbation humaine requise');
  });
});

describe('appels', () => {
  it('interroge la collection du périmètre', async () => {
    const { deps, search } = harness();
    const scope = resolveScope(deps, 'agent-1');
    const result = await callGatewayTool(deps, scope, 'rag_search', {
      collection: 'compta',
      query: 'amortissement',
    });
    expect(result.isError).toBeUndefined();
    expect(search).toHaveBeenCalledWith('col-1', 'amortissement', 5);
  });

  it('refuse une collection hors périmètre, même avec le bon slug', async () => {
    const { deps, search } = harness();
    const scope = resolveScope(deps, 'agent-1');
    const result = await callGatewayTool(deps, scope, 'rag_search', {
      collection: 'rh',
      query: 'congés',
    });
    expect(result.isError).toBe(true);
    expect(search).not.toHaveBeenCalled();
  });

  it('borne topK au plafond', async () => {
    const { deps, search } = harness();
    await callGatewayTool(deps, resolveScope(deps, null), 'rag_search', {
      collection: 'compta',
      query: 'tva',
      topK: 999,
    });
    expect(search).toHaveBeenCalledWith('col-1', 'tva', 10);
  });

  it('refuse une requête trop courte sans appeler le moteur', async () => {
    const { deps, search } = harness();
    const result = await callGatewayTool(deps, resolveScope(deps, null), 'rag_search', {
      collection: 'compta',
      query: 'a',
    });
    expect(result.isError).toBe(true);
    expect(search).not.toHaveBeenCalled();
  });

  it('refuse un outil sous approbation au lieu de contourner le broker', async () => {
    const { deps } = harness({
      servers: [customServer({ tools: [customTool({ requiresApproval: true })] })],
    });
    const result = await callGatewayTool(deps, resolveScope(deps, null), 'crm__lister', {
      siret: '123',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('approbation humaine');
  });

  it('refuse un outil hors périmètre et un nom inconnu', async () => {
    const { deps } = harness({
      servers: [customServer(), customServer({ id: 'srv-9', slug: 'paie' })],
    });
    const scope = resolveScope(deps, 'agent-1');
    expect((await callGatewayTool(deps, scope, 'paie__lister', {})).isError).toBe(true);
    expect((await callGatewayTool(deps, scope, 'crm__inexistant', {})).isError).toBe(true);
    expect((await callGatewayTool(deps, scope, 'inconnu', {})).isError).toBe(true);
  });

  it('rend une erreur d’outil sans lever, et la journalise', async () => {
    const { deps, warnings } = harness();
    const scope = resolveScope(deps, null);
    const result = await callGatewayTool(deps, scope, 'crm__lister', { siret: '000' });
    // L'action pointe un hôte inexistant : l'appel réseau échoue, la passerelle
    // le convertit en résultat d'erreur — une exception fermerait la session.
    expect(result.isError).toBe(true);
    expect(warnings.some((w) => w.includes('crm.lister'))).toBe(true);
  }, 20000);
});

describe('résolution du nom d’agent', () => {
  it('retrouve un agent dont l’accent a été perdu par l’en-tête HTTP', () => {
    const { deps } = harness({ agents: [agent({ name: 'Développeur' })] });
    // Ce que Node lit quand un client envoie « Développeur » en UTF-8 : les
    // valeurs d'en-tête sont du latin-1 pour la spécification HTTP.
    const mojibake = Buffer.from('Développeur', 'utf8').toString('latin1');
    expect(resolveScope(deps, mojibake).agent?.id).toBe('agent-1');
  });

  it('accepte un nom écrit sans accent, comme dans une config à la main', () => {
    const { deps } = harness({ agents: [agent({ name: 'Sécurité' })] });
    expect(resolveScope(deps, 'securite').agent?.id).toBe('agent-1');
  });
});

describe('outils de contrôle depuis un client tiers', () => {
  it('ne les annonce pas sans agent identifié', () => {
    /* Au nom de qui la carte serait-elle créée ? Les annoncer quand même ferait
       échouer chaque appel après coup, la pire façon de dire non. */
    const { deps } = governedHarness();
    const names = listGatewayTools(resolveScope(deps, null), deps).map((t) => t.name);
    expect(names).not.toContain('task_create');
    expect(names).toContain('rag_search');
  });

  it('les annonce dès qu’un agent est identifié', () => {
    const { deps } = governedHarness();
    const names = listGatewayTools(resolveScope(deps, 'agent-1'), deps).map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(['task_create', 'task_update', 'send_to_agent', 'memory_save']),
    );
  });

  it('ne les annonce pas sur une passerelle sans dépendances de contrôle', () => {
    // Le pont stdio en construit une ainsi : elle doit rester fonctionnelle.
    const { deps } = harness();
    const names = listGatewayTools(resolveScope(deps, 'agent-1'), deps).map((t) => t.name);
    expect(names).not.toContain('task_create');
  });

  it('refuse un appel de contrôle sans agent, en disant quoi faire', () => {
    const { deps } = governedHarness();
    return callGatewayTool(deps, resolveScope(deps, null), 'task_create', {
      title: 'x',
    }).then((result) => {
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('x-maestro-agent');
    });
  });

  it('ouvre une session externe avant d’agir', async () => {
    /* Avant, jamais après : c'est la session qui donne son parent à une
       délégation. L'ouvrir ensuite laisserait un run orphelin, non annulable en
       cascade — le trou que ce lot comble. */
    const { deps, touch, created } = governedHarness();
    const result = await callGatewayTool(deps, resolveScope(deps, 'agent-1'), 'task_create', {
      title: 'Relire la liasse',
    });
    expect(touch).toHaveBeenCalledOnce();
    expect(created[0]?.agentId).toBe('agent-1');
    expect(result.isError).toBeUndefined();
  });

  it('rattache une délégation à la session externe', async () => {
    const { deps, start } = governedHarness();
    await callGatewayTool(deps, resolveScope(deps, 'agent-1'), 'send_to_agent', {
      agentName: 'Relecteur',
      prompt: 'relis ceci',
    });
    const call = start.mock.calls[0]?.[0];
    expect(call?.parentRunId).toBe('run_ext_1');
    expect(call?.origin).toBe('agent');
    expect(call?.depth).toBe(1);
  });

  it('applique les garde-fous de délégation, comme pour un agent interne', async () => {
    // Un client tiers qui échapperait à la limite de profondeur pourrait
    // déclencher une cascade que rien n'arrête.
    const { deps } = governedHarness();
    const result = await callGatewayTool(deps, resolveScope(deps, 'agent-1'), 'send_to_agent', {
      agentName: 'Inconnu',
      prompt: 'x',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('introuvable');
  });

  it('journalise chaque action dans la session', async () => {
    const { deps, record } = governedHarness();
    await callGatewayTool(deps, resolveScope(deps, 'agent-1'), 'task_create', { title: 'x' });
    expect(record).toHaveBeenCalledWith(expect.anything(), 'task_create', 'ok');
  });
});

describe('approbation humaine depuis un client tiers', () => {
  const withApproval = () => ({
    servers: [customServer({ tools: [customTool({ requiresApproval: true })] })],
  });

  it('demande la décision au broker, puis exécute si elle est accordée', async () => {
    const { deps, requestHumanApproval } = governedHarness({
      approval: 'allow',
      ...withApproval(),
    });
    const result = await callGatewayTool(deps, resolveScope(deps, 'agent-1'), 'crm__lister', {
      siret: '123',
    });
    expect(requestHumanApproval).toHaveBeenCalledOnce();
    // La demande porte le run de la session : sans lui, l'approbation
    // n'apparaîtrait rattachée à rien dans l'historique.
    expect(requestHumanApproval.mock.calls[0]?.[0]).toBe('run_ext_1');
    // L'outil pointe sur un port fermé : l'exécution échoue, mais elle a bien eu lieu.
    expect(result.content[0]?.text).not.toContain('approbation humaine');
  }, 20000);

  it('refuse l’appel quand l’opérateur refuse', async () => {
    const { deps } = governedHarness({ approval: 'deny', ...withApproval() });
    const result = await callGatewayTool(deps, resolveScope(deps, 'agent-1'), 'crm__lister', {
      siret: '123',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Refusé en test');
  });

  it('refuse sans agent identifié, faute de pouvoir demander quoi que ce soit', async () => {
    const { deps } = governedHarness(withApproval());
    const result = await callGatewayTool(deps, resolveScope(deps, null), 'crm__lister', {
      siret: '123',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('approbation humaine');
  });
});
