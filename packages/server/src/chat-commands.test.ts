import { describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from '@maestro/shared';
import {
  executeChatCommand,
  parseChatCommand,
  renderHtml,
  renderMarkdown,
  renderMrkdwn,
  renderPlain,
  type ChatDeps,
} from './chat-commands.ts';

function agent(name: string, patch: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: `agt_${name}`,
    name,
    emoji: '🤖',
    description: '',
    model: 'sonnet',
    engine: 'sdk',
    permissionMode: 'default',
    approvalPolicy: 'auto',
    systemPrompt: null,
    cliAgent: null,
    parentAgentId: null,
    resiliencePolicyId: null,
    pluginIds: [],
    mcpServerIds: [],
    ragCollectionIds: [],
    workspaceDir: '/tmp',
    memoryEnabled: false,
    allowedTools: null,
    disallowedTools: null,
    maxTurns: null,
    timeoutSec: null,
    tokenBudget: null,
    sandbox: null,
    color: '#fff',
    pinned: null,
    archived: false,
    createdAt: '2026-08-28T09:00:00.000Z',
    updatedAt: '2026-08-28T09:00:00.000Z',
    ...patch,
  };
}

function deps(patch: Partial<ChatDeps> = {}): ChatDeps {
  const agents = [agent('Comptable'), agent('Veilleur')];
  return {
    listAgents: () => agents,
    findAgent: (name) => agents.find((a) => a.name === name) ?? null,
    activeRuns: () => 2,
    queuedRuns: () => 1,
    pendingApprovals: () => 0,
    listPendingApprovalIds: () => [],
    startRun: () => 'run_abc',
    ...patch,
  };
}

describe('reconnaissance des commandes', () => {
  it('reconnaît les commandes simples', () => {
    expect(parseChatCommand('/help').kind).toBe('help');
    expect(parseChatCommand('/start').kind).toBe('help');
    expect(parseChatCommand('/agents').kind).toBe('agents');
    expect(parseChatCommand('/status').kind).toBe('status');
    expect(parseChatCommand('/approvals').kind).toBe('approvals');
  });

  it('ignore un message qui ne commence pas par une barre oblique', () => {
    expect(parseChatCommand('bonjour').kind).toBe('none');
    expect(parseChatCommand('parle de /status un jour').kind).toBe('none');
  });

  it('ignore une commande inconnue', () => {
    expect(parseChatCommand('/inconnue').kind).toBe('none');
  });

  it('tolère les espaces autour', () => {
    expect(parseChatCommand('   /status   ').kind).toBe('status');
  });

  it('ignore la casse de la commande', () => {
    expect(parseChatCommand('/STATUS').kind).toBe('status');
  });

  /*
   * Telegram suffixe les commandes du nom du bot dans les groupes.
   * Sans ce retrait, `/status@maestro_bot` n'était reconnu par aucun canal.
   */
  it('retire le suffixe de mention du bot', () => {
    expect(parseChatCommand('/status@maestro_bot').kind).toBe('status');
    expect(parseChatCommand('/run@maestro_bot Comptable fais le bilan')).toEqual({
      kind: 'run',
      agentName: 'Comptable',
      prompt: 'fais le bilan',
    });
  });

  it('découpe /run en agent et prompt', () => {
    expect(parseChatCommand('/run Comptable analyse le bilan 2025')).toEqual({
      kind: 'run',
      agentName: 'Comptable',
      prompt: 'analyse le bilan 2025',
    });
  });

  it('conserve la casse du nom d’agent et du prompt', () => {
    const parsed = parseChatCommand('/run Comptable Analyse LE Bilan');
    expect(parsed).toMatchObject({ agentName: 'Comptable', prompt: 'Analyse LE Bilan' });
  });

  it('conserve les sauts de ligne du prompt', () => {
    const parsed = parseChatCommand('/run Comptable ligne 1\nligne 2');
    expect(parsed).toMatchObject({ prompt: 'ligne 1\nligne 2' });
  });

  it('demande l’usage quand /run est incomplet', () => {
    expect(parseChatCommand('/run').kind).toBe('usage');
    expect(parseChatCommand('/run Comptable').kind).toBe('usage');
    expect(parseChatCommand('/run Comptable    ').kind).toBe('usage');
  });
});

describe('exécution', () => {
  it('ne répond rien à un message ordinaire', () => {
    expect(executeChatCommand({ kind: 'none' }, deps())).toBeNull();
  });

  it('liste les agents avec leur modèle et leur moteur', () => {
    const reply = executeChatCommand({ kind: 'agents' }, deps())!;
    expect(renderPlain(reply)).toContain('Comptable — sonnet (sdk)');
    expect(reply.lines).toHaveLength(2);
  });

  it('le dit quand il n’y a aucun agent', () => {
    const reply = executeChatCommand({ kind: 'agents' }, deps({ listAgents: () => [] }))!;
    expect(renderPlain(reply)).toBe('Aucun agent.');
  });

  it('rapporte l’état de l’orchestrateur', () => {
    const text = renderPlain(executeChatCommand({ kind: 'status' }, deps())!);
    expect(text).toContain('Runs actifs : 2');
    expect(text).toContain('En file : 1');
  });

  it('lance un run et rend son identifiant', () => {
    const startRun = vi.fn(() => 'run_xyz');
    const reply = executeChatCommand(
      { kind: 'run', agentName: 'Comptable', prompt: 'fais le bilan' },
      deps({ startRun }),
    )!;
    expect(startRun).toHaveBeenCalledWith('agt_Comptable', 'fais le bilan');
    expect(renderPlain(reply)).toContain('run_xyz');
  });

  it('propose les agents existants quand le nom est inconnu', () => {
    const reply = executeChatCommand({ kind: 'run', agentName: 'Fantôme', prompt: 'x' }, deps())!;
    const text = renderPlain(reply);
    expect(text).toContain('Fantôme');
    expect(text).toContain('Comptable, Veilleur');
  });

  /*
   * Un lancement refusé (agent occupé, plafond de délégation) doit se lire dans
   * le canal. Laisser l'exception remonter tuerait la boucle de réception, et
   * la passerelle cesserait de répondre à tout le monde.
   */
  it('rend le motif d’un lancement refusé', () => {
    const reply = executeChatCommand(
      { kind: 'run', agentName: 'Comptable', prompt: 'x' },
      deps({
        startRun: () => {
          throw new Error('agent déjà occupé');
        },
      }),
    )!;
    expect(renderPlain(reply)).toContain('agent déjà occupé');
  });

  it('ne détaille rien quand aucune approbation n’attend', () => {
    const reply = executeChatCommand({ kind: 'approvals' }, deps())!;
    expect(renderPlain(reply)).toBe('Aucune approbation en attente.');
    expect(reply.approvalIds).toBeUndefined();
  });

  it('détaille les approbations en attente, et borne le lot', () => {
    const reply = executeChatCommand(
      { kind: 'approvals' },
      deps({
        pendingApprovals: () => 12,
        listPendingApprovalIds: (limit) =>
          Array.from({ length: Math.min(limit, 12) }, (_u, i) => `apr_${i}`),
      }),
    )!;
    expect(reply.approvalIds).toHaveLength(5);
    expect(renderPlain(reply)).toContain('12 approbation(s)');
    expect(renderPlain(reply)).toContain('les 5 plus anciennes');
  });

  it('n’annonce pas de troncature quand tout est montré', () => {
    const reply = executeChatCommand(
      { kind: 'approvals' },
      deps({ pendingApprovals: () => 2, listPendingApprovalIds: () => ['a', 'b'] }),
    )!;
    expect(renderPlain(reply)).not.toContain('plus anciennes');
  });

  it('explique l’usage d’une commande mal formée', () => {
    const reply = executeChatCommand(parseChatCommand('/run'), deps())!;
    expect(renderPlain(reply)).toContain('/run <agent> <prompt>');
  });
});

describe('rendus par transport', () => {
  const reply = executeChatCommand({ kind: 'help' }, deps())!;

  it('Telegram emploie du HTML', () => {
    const html = renderHtml(reply);
    expect(html).toContain('<b>🎛 Maestro</b>');
    expect(html).toContain('<code>/agents</code>');
  });

  it('Discord emploie du markdown', () => {
    const md = renderMarkdown(reply);
    expect(md).toContain('**🎛 Maestro**');
    expect(md).toContain('`/agents`');
  });

  /* Slack n'est pas du markdown : le gras y prend une seule astérisque. */
  it('Slack emploie mrkdwn, gras à une astérisque', () => {
    const mrkdwn = renderMrkdwn(reply);
    expect(mrkdwn).toContain('*🎛 Maestro*');
    expect(mrkdwn).not.toContain('**');
  });

  /* Les chevrons de « <agent> » sont un texte littéral, pas du balisage : on
     vérifie l'absence de marqueurs, pas celle de caractères. */
  it('le rendu brut ne pose aucun marqueur', () => {
    const text = renderPlain(reply);
    expect(text).not.toContain('<b>');
    expect(text).not.toContain('**');
    expect(text).not.toContain('`');
    expect(text).toContain('/run <agent> <prompt>');
  });
});

describe('échappement', () => {
  /*
   * Un nom d'agent est saisi par l'utilisateur : il peut contenir n'importe quoi.
   * Une erreur d'échappement ne casse l'affichage que sur un seul canal, ce qui
   * en fait le défaut le plus pénible à reproduire.
   */
  const hostile = agent('<b>*_`x`_*</b>');
  const hostileDeps = deps({ listAgents: () => [hostile], findAgent: () => hostile });
  const listing = executeChatCommand({ kind: 'agents' }, hostileDeps)!;

  it('HTML : aucune balise ne survit', () => {
    const html = renderHtml(listing);
    expect(html).toContain('&lt;b&gt;');
    expect(html).not.toContain('<b>*');
  });

  it('markdown : les marqueurs sont neutralisés', () => {
    const md = renderMarkdown(listing);
    expect(md).toContain('\\*');
    expect(md).toContain('\\_');
    expect(md).toContain('\\`');
  });

  it('mrkdwn : les chevrons sont encodés en entités', () => {
    const mrkdwn = renderMrkdwn(listing);
    expect(mrkdwn).toContain('&lt;b&gt;');
    expect(mrkdwn).not.toContain('<b>');
  });

  it('un backtick dans un identifiant ne casse pas le bloc de code', () => {
    const reply = executeChatCommand(
      { kind: 'run', agentName: 'Comptable', prompt: 'x' },
      deps({ startRun: () => 'run_`cassé`' }),
    )!;
    const md = renderMarkdown(reply);
    expect(md).toContain('`run_cassé`');
  });
});
