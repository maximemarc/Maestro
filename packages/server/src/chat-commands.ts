/**
 * Cœur des commandes de messagerie, indépendant du transport.
 *
 * Telegram, Discord et Slack posent les mêmes questions à Maestro et reçoivent
 * les mêmes réponses ; seul le balisage change. Tripler la logique aurait garanti
 * qu'une commande corrigée sur un canal reste cassée sur les deux autres.
 *
 * D'où la séparation : ici on décide *quoi* répondre, sous une forme structurée
 * et sans une seule balise ; chaque passerelle décide *comment* l'afficher — HTML
 * pour Telegram, markdown pour Discord, mrkdwn pour Slack. Tout ce module est
 * pur au sens où il ne parle à aucun réseau, ce qui le rend testable.
 */
import type { AgentConfig } from '@maestro/shared';

/** Commande reconnue dans un message. */
export type ChatCommand =
  | { kind: 'help' }
  | { kind: 'agents' }
  | { kind: 'status' }
  | { kind: 'approvals' }
  | { kind: 'run'; agentName: string; prompt: string }
  /** Message qui ne s'adresse pas à Maestro : à ignorer sans répondre. */
  | { kind: 'none' }
  /** Commande connue mais mal formée — on répond en expliquant l'usage. */
  | { kind: 'usage'; command: string; usage: string };

/**
 * Fragment de réponse.
 *
 * `emphasis` marque un nom propre ou une valeur que la passerelle mettra en
 * gras ; `code` un identifiant à rendre en police fixe. Décrire l'intention
 * plutôt que le balisage évite d'échapper trois fois le même texte de trois
 * façons — et une erreur d'échappement sur un nom d'agent contenant `<` casse
 * l'affichage sur un seul des trois canaux, ce qui est le pire cas à déboguer.
 */
export type ChatSpan = { text: string } | { emphasis: string } | { code: string };

export interface ChatLine {
  spans: ChatSpan[];
}

export interface ChatReply {
  lines: ChatLine[];
  /**
   * Approbations à présenter avec leurs boutons, quand le canal en propose.
   * Les canaux sans interaction retombent sur un rendu textuel.
   */
  approvalIds?: string[];
}

export interface ChatDeps {
  listAgents: () => AgentConfig[];
  findAgent: (name: string) => AgentConfig | null;
  activeRuns: () => number;
  queuedRuns: () => number;
  pendingApprovals: () => number;
  listPendingApprovalIds: (limit: number) => string[];
  /** Lance un run et rend son identifiant, ou lève avec un motif lisible. */
  startRun: (agentId: string, prompt: string) => string;
}

/** Nombre d'approbations détaillées d'un coup — au-delà, le canal est noyé. */
const APPROVAL_BATCH = 5;

const RUN_USAGE = '/run <agent> <prompt>';

function line(...spans: ChatSpan[]): ChatLine {
  return { spans };
}

function plain(text: string): ChatReply {
  return { lines: [line({ text })] };
}

/**
 * Reconnaît une commande.
 *
 * La casse est ignorée sur le nom de la commande, jamais sur ses arguments : un
 * nom d'agent est sensible à la casse côté résolution, et normaliser le prompt
 * serait absurde.
 *
 * Le suffixe `@nom_du_bot` que Telegram ajoute dans les groupes est retiré :
 * sans cela, `/status@maestro_bot` n'était reconnu par aucune passerelle.
 */
export function parseChatCommand(raw: string): ChatCommand {
  const text = raw.trim();
  if (!text.startsWith('/')) return { kind: 'none' };

  const spaceIdx = text.search(/\s/);
  const head = (spaceIdx === -1 ? text : text.slice(0, spaceIdx)).toLowerCase();
  const rest = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1).trim();
  const command = head.split('@')[0] ?? head;

  switch (command) {
    case '/start':
    case '/help':
      return { kind: 'help' };
    case '/agents':
      return { kind: 'agents' };
    case '/status':
      return { kind: 'status' };
    case '/approvals':
      return { kind: 'approvals' };
    case '/run': {
      const gap = rest.search(/\s/);
      if (gap === -1 || rest.slice(gap + 1).trim() === '') {
        return { kind: 'usage', command: '/run', usage: RUN_USAGE };
      }
      return {
        kind: 'run',
        agentName: rest.slice(0, gap),
        prompt: rest.slice(gap + 1).trim(),
      };
    }
    default:
      return { kind: 'none' };
  }
}

/** Exécute une commande et rend la réponse à afficher. */
export function executeChatCommand(command: ChatCommand, deps: ChatDeps): ChatReply | null {
  switch (command.kind) {
    case 'none':
      return null;

    case 'usage':
      return plain(`Usage : ${command.usage}`);

    case 'help':
      return {
        lines: [
          line({ emphasis: '🎛 Maestro' }),
          line({ code: '/agents' }, { text: ' — liste des agents' }),
          line({ code: '/status' }, { text: ' — état de l’orchestrateur' }),
          line({ code: '/approvals' }, { text: ' — approbations en attente' }),
          line({ code: RUN_USAGE }, { text: ' — lancer un run' }),
        ],
      };

    case 'agents': {
      const agents = deps.listAgents();
      if (agents.length === 0) return plain('Aucun agent.');
      return {
        lines: agents.map((a) =>
          line(
            { text: `${a.emoji} ` },
            { emphasis: a.name },
            { text: ` — ${a.model} (${a.engine})` },
          ),
        ),
      };
    }

    case 'status':
      return {
        lines: [
          line({ text: `Runs actifs : ${deps.activeRuns()}` }),
          line({ text: `En file : ${deps.queuedRuns()}` }),
          line({ text: `Approbations en attente : ${deps.pendingApprovals()}` }),
        ],
      };

    case 'approvals': {
      const ids = deps.listPendingApprovalIds(APPROVAL_BATCH);
      if (ids.length === 0) return plain('Aucune approbation en attente.');
      const total = deps.pendingApprovals();
      const lines = [line({ text: `${total} approbation(s) en attente :` })];
      if (total > ids.length) {
        lines.push(line({ text: `(les ${ids.length} plus anciennes sont détaillées ci-dessous)` }));
      }
      return { lines, approvalIds: ids };
    }

    case 'run': {
      const agent = deps.findAgent(command.agentName);
      if (!agent) {
        const names = deps
          .listAgents()
          .map((a) => a.name)
          .join(', ');
        return {
          lines: [
            line(
              { text: 'Agent ' },
              { emphasis: command.agentName },
              { text: ' introuvable. Disponibles : ' },
              { text: names || 'aucun' },
            ),
          ],
        };
      }
      try {
        const runId = deps.startRun(agent.id, command.prompt);
        return {
          lines: [
            line(
              { text: '🚀 Run ' },
              { code: runId },
              { text: ' lancé pour ' },
              { emphasis: `${agent.emoji} ${agent.name}` },
              { text: '. Je te notifie à la fin.' },
            ),
          ],
        };
      } catch (err) {
        return plain(`Échec du lancement : ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

// -- Rendus par transport ----------------------------------------------------

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Telegram, en HTML — le mode déjà employé par la passerelle historique. */
export function renderHtml(reply: ChatReply): string {
  return reply.lines
    .map((l) =>
      l.spans
        .map((span) => {
          if ('emphasis' in span) return `<b>${escapeHtml(span.emphasis)}</b>`;
          if ('code' in span) return `<code>${escapeHtml(span.code)}</code>`;
          return escapeHtml(span.text);
        })
        .join(''),
    )
    .join('\n');
}

/**
 * Échappement markdown de Discord.
 *
 * Seuls les caractères qui ouvrent un balisage sont échappés. Un nom d'agent
 * contenant `_` ou `*` mettrait sinon la moitié du message en italique, et un
 * backtick isolé casserait tout le bloc.
 */
function escapeMarkdown(value: string): string {
  return value.replaceAll(/([\\*_`~|>])/g, '\\$1');
}

/** Discord, en markdown. */
export function renderMarkdown(reply: ChatReply): string {
  return reply.lines
    .map((l) =>
      l.spans
        .map((span) => {
          if ('emphasis' in span) return `**${escapeMarkdown(span.emphasis)}**`;
          if ('code' in span) return `\`${span.code.replaceAll('`', '')}\``;
          return escapeMarkdown(span.text);
        })
        .join(''),
    )
    .join('\n');
}

/**
 * Slack, en mrkdwn.
 *
 * Ce n'est pas du markdown : le gras s'écrit avec une seule astérisque, et
 * `&`, `<`, `>` doivent être encodés en entités sous peine d'être interprétés
 * comme des liens ou des mentions.
 */
function escapeMrkdwn(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function renderMrkdwn(reply: ChatReply): string {
  return reply.lines
    .map((l) =>
      l.spans
        .map((span) => {
          if ('emphasis' in span) return `*${escapeMrkdwn(span.emphasis)}*`;
          if ('code' in span) return `\`${escapeMrkdwn(span.code)}\``;
          return escapeMrkdwn(span.text);
        })
        .join(''),
    )
    .join('\n');
}

/** Rendu sans balisage, pour un canal qui n'en accepte aucun. */
export function renderPlain(reply: ChatReply): string {
  return reply.lines
    .map((l) =>
      l.spans
        .map((span) =>
          'emphasis' in span ? span.emphasis : 'code' in span ? span.code : span.text,
        )
        .join(''),
    )
    .join('\n');
}
