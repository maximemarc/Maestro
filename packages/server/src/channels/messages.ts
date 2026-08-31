/**
 * Contenu des notifications et des commandes, sans transport.
 *
 * Tout ce qui est ici était mêlé au bot Telegram, et n'avait pourtant rien de
 * telegramien : décider qu'un run mérite une notification, lister les agents,
 * lancer un run depuis un message. C'est de la logique d'orchestrateur, et
 * c'est elle qu'un second canal aurait dû recopier.
 *
 * Les fonctions rendent des `ChannelMessage` structurés : le rendu appartient
 * au canal.
 */
import type { Approval, Run } from '@maestro/shared';
import type { AgentService } from '../agents.ts';
import type { Store } from '../db.ts';
import type { RunEngine } from '../runs.ts';
import { truncate } from '../util.ts';
import type { ChannelMessage } from './types.ts';

export interface MessageDeps {
  store: Store;
  agents: AgentService;
  engine: RunEngine;
}

/** Longueur du résultat repris dans une notification. */
const RESULT_MAX = 800;

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

/** Message d'une demande d'approbation, ou `null` si elle n'attend plus. */
export function approvalMessage(deps: MessageDeps, approval: Approval): ChannelMessage | null {
  if (approval.status !== 'pending') return null;
  const agent = deps.agents.get(approval.agentId);
  return {
    title: 'Approbation demandée',
    tone: 'warn',
    fields: [
      { label: 'Agent', value: agent?.name ?? approval.agentId },
      { label: 'Outil', value: approval.toolName },
    ],
    body: truncate(JSON.stringify(approval.input ?? {}), 300),
    actions: [
      { id: `apr:${approval.id}:allow`, label: 'Autoriser', style: 'primary' },
      { id: `apr:${approval.id}:deny`, label: 'Refuser', style: 'danger' },
    ],
  };
}

/**
 * Faut-il notifier la fin de ce run ?
 *
 * Trois cas, inchangés depuis le bot d'origine : un run lancé depuis un canal
 * (dont l'auteur attend la réponse), une routine qui l'a demandé, ou le réglage
 * global. Le reste passerait pour du bruit — un orchestrateur qui notifie tout
 * finit par n'être plus lu.
 */
export function shouldNotifyRunEnd(deps: MessageDeps, run: Run): boolean {
  if (!run.endedAt) return false;
  /* `telegram` reste la valeur historique d'un run lancé depuis un canal. La
     renommer imposerait une migration des runs déjà enregistrés, pour la seule
     satisfaction du vocabulaire. */
  if (run.origin === 'telegram') return true;
  if (deps.store.getSettings().telegramNotifyAllRuns) return true;
  if (run.origin === 'routine' && run.originId) {
    return deps.store.getRoutine(run.originId)?.notify ?? false;
  }
  return false;
}

export function runEndMessage(deps: MessageDeps, run: Run): ChannelMessage {
  const agent = deps.agents.get(run.agentId);
  const tone = run.status === 'succeeded' ? 'ok' : run.status === 'cancelled' ? 'info' : 'error';
  const fields = [
    { label: 'Agent', value: agent?.name ?? run.agentId },
    { label: 'Statut', value: run.status },
    { label: 'Tours', value: String(run.numTurns) },
    { label: 'Coût', value: `$${run.costUsd.toFixed(4)}` },
  ];
  /* La bascule n'apparaît que quand elle a eu lieu : afficher « 1 tentative »
     sur chaque run noierait les rares cas qui méritent un regard. */
  if (run.attemptCount > 1) {
    fields.push({
      label: 'Tentatives',
      value: `${run.attemptCount}${run.accountName ? ` — terminé sur « ${run.accountName} »` : ''}`,
    });
  }
  if (run.error) fields.push({ label: 'Erreur', value: truncate(run.error, 300) });

  return {
    title: 'Run terminé',
    tone,
    fields,
    body: run.resultText ? truncate(run.resultText, RESULT_MAX) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Commandes entrantes
// ---------------------------------------------------------------------------

export interface ParsedCommand {
  name: 'help' | 'agents' | 'status' | 'approvals' | 'run';
  /** Arguments bruts, tels que tapés après le nom de la commande. */
  rest: string;
}

/**
 * Analyse une ligne reçue d'un canal.
 *
 * Rend `null` pour tout ce qui n'est pas une commande connue : un canal reçoit
 * aussi de la conversation ordinaire, et répondre « commande inconnue » à
 * chaque phrase rendrait le canal inutilisable.
 */
export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const spaceIdx = trimmed.indexOf(' ');
  const head = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
  const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

  switch (head) {
    case '/start':
    case '/help':
      return { name: 'help', rest };
    case '/agents':
      return { name: 'agents', rest };
    case '/status':
      return { name: 'status', rest };
    case '/approvals':
      return { name: 'approvals', rest };
    case '/run':
      return { name: 'run', rest };
    default:
      return null;
  }
}

/**
 * Exécute une commande et rend les messages à renvoyer.
 *
 * Plusieurs messages sont possibles : `/approvals` en produit un par
 * approbation en attente, chacun avec ses actions. Les fusionner ferait perdre
 * les boutons, qui portent l'identifiant de leur approbation.
 */
export function runCommand(deps: MessageDeps, command: ParsedCommand): ChannelMessage[] {
  switch (command.name) {
    case 'help':
      return [
        {
          title: 'Maestro',
          tone: 'info',
          body: [
            '/agents — liste des agents',
            '/status — état de l’orchestrateur',
            '/approvals — approbations en attente',
            '/run <agent> <prompt> — lancer un run',
          ].join('\n'),
        },
      ];

    case 'agents': {
      const agents = deps.agents.list();
      if (agents.length === 0) return [{ title: 'Aucun agent.', tone: 'info' }];
      return [
        {
          title: `${agents.length} agent(s)`,
          tone: 'info',
          fields: agents.map((a) => ({
            label: `${a.emoji} ${a.name}`,
            value: `${a.model} (${a.engine})`,
          })),
        },
      ];
    }

    case 'status':
      return [
        {
          title: 'État de l’orchestrateur',
          tone: 'info',
          fields: [
            { label: 'Runs actifs', value: String(deps.engine.activeCount()) },
            { label: 'En file', value: String(deps.engine.queuedCount()) },
            {
              label: 'Approbations en attente',
              value: String(deps.store.countPendingApprovals()),
            },
          ],
        },
      ];

    case 'approvals': {
      const pending = deps.store.listApprovals('pending');
      if (pending.length === 0) {
        return [{ title: 'Aucune approbation en attente.', tone: 'info' }];
      }
      /* Bornée : un canal n'est pas une liste paginée, et déverser cinquante
         demandes d'un coup les rendrait toutes illisibles. */
      return pending
        .slice(0, 5)
        .map((approval) => approvalMessage(deps, approval))
        .filter((m): m is ChannelMessage => m !== null);
    }

    case 'run': {
      const spaceIdx = command.rest.indexOf(' ');
      if (spaceIdx === -1) {
        return [{ title: 'Usage : /run <agent> <prompt>', tone: 'warn' }];
      }
      const agentName = command.rest.slice(0, spaceIdx);
      const prompt = command.rest.slice(spaceIdx + 1).trim();
      const agent = deps.agents.getByName(agentName);
      if (!agent) {
        const names = deps.agents
          .list()
          .map((a) => a.name)
          .join(', ');
        return [
          {
            title: `Agent « ${agentName} » introuvable.`,
            tone: 'warn',
            fields: [{ label: 'Disponibles', value: names || '(aucun)' }],
          },
        ];
      }
      try {
        const run = deps.engine.start({ agentId: agent.id, prompt, origin: 'telegram' });
        return [
          {
            title: `Run lancé pour ${agent.emoji} ${agent.name}`,
            tone: 'ok',
            fields: [{ label: 'Run', value: run.id }],
            body: 'Tu seras notifié à la fin.',
          },
        ];
      } catch (err) {
        return [
          {
            title: 'Échec du lancement',
            tone: 'error',
            body: err instanceof Error ? err.message : String(err),
          },
        ];
      }
    }
  }
}

/** Décode l'identifiant d'une action d'approbation, ou `null` s'il n'en est pas. */
export function parseApprovalAction(
  actionId: string,
): { approvalId: string; decision: 'allow' | 'deny' } | null {
  const [kind, approvalId, decision] = actionId.split(':');
  if (kind !== 'apr' || !approvalId) return null;
  if (decision !== 'allow' && decision !== 'deny') return null;
  return { approvalId, decision };
}
