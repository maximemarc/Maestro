/**
 * Contenu des notifications, sans transport.
 *
 * Tout ce qui est ici vivait dans les passerelles, et n'avait pourtant rien de
 * telegramien ni de slackien : décider qu'un run mérite une notification, et
 * quoi y mettre. C'est de la logique d'orchestrateur — et elle était **recopiée
 * dans les trois passerelles**, chacune avec sa propre mise en page et sa propre
 * version de « faut-il notifier ». Trois copies qui divergent au premier
 * réglage ajouté.
 *
 * Les commandes entrantes, elles, appartiennent à `chat-commands.ts`. La
 * séparation est nette : ici c'est Maestro qui parle, là c'est un humain qui
 * demande.
 */
import { CHAT_ORIGINS, type Approval, type Run } from '@maestro/shared';
import type { AgentService } from '../agents.ts';
import type { Store } from '../db.ts';
import type { ChatLine, ChatReply, ChatSpan } from '../chat-commands.ts';
import { truncate } from '../util.ts';

export interface MessageDeps {
  store: Store;
  agents: AgentService;
}

/** Longueur du résultat repris dans une notification. */
const RESULT_MAX = 800;
/** Longueur de l'entrée d'outil montrée dans une demande d'approbation. */
const INPUT_MAX = 300;
const ERROR_MAX = 300;

function line(...spans: ChatSpan[]): ChatLine {
  return { spans };
}

/** Message d'une demande d'approbation, ou `null` si elle n'attend plus. */
export function approvalMessage(deps: MessageDeps, approval: Approval): ChatReply | null {
  if (approval.status !== 'pending') return null;
  const agent = deps.agents.get(approval.agentId);
  return {
    lines: [
      line({ text: '🔐 ' }, { emphasis: 'Approbation demandée' }),
      line({ text: 'Agent : ' }, { text: agent?.name ?? approval.agentId }),
      line({ text: 'Outil : ' }, { code: approval.toolName }),
      {
        ...line(
          { text: 'Entrée : ' },
          { code: truncate(JSON.stringify(approval.input ?? {}), INPUT_MAX) },
        ),
        detail: true,
      },
    ],
    approvalIds: [approval.id],
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
  /* Toutes les origines conversationnelles, pas seulement Telegram : quelqu'un
     attend la réponse dans le salon d'où il a lancé le run, quel qu'il soit. */
  if (CHAT_ORIGINS.includes(run.origin)) return true;
  if (deps.store.getSettings().notifyAllRuns) return true;
  if (run.origin === 'routine' && run.originId) {
    return deps.store.getRoutine(run.originId)?.notify ?? false;
  }
  return false;
}

export function runEndMessage(deps: MessageDeps, run: Run): ChatReply {
  const agent = deps.agents.get(run.agentId);
  const icon = run.status === 'succeeded' ? '✅' : run.status === 'cancelled' ? '⏹' : '❌';
  const lines: ChatLine[] = [
    line(
      { text: `${icon} ` },
      { emphasis: 'Run terminé' },
      { text: ' — ' },
      { text: agent?.name ?? run.agentId },
    ),
    line(
      { text: 'Statut : ' },
      { text: run.status },
      { text: ' · ' },
      { text: `${run.numTurns} tours` },
      { text: ' · ' },
      { text: `$${run.costUsd.toFixed(4)}` },
    ),
  ];

  /* La bascule n'apparaît que quand elle a eu lieu : afficher « 1 tentative »
     sur chaque run noierait les rares cas qui méritent un regard. */
  if (run.attemptCount > 1) {
    lines.push(
      line(
        { text: 'Tentatives : ' },
        { text: String(run.attemptCount) },
        ...(run.accountName
          ? ([{ text: ' — terminé sur ' }, { emphasis: run.accountName }] as ChatSpan[])
          : []),
      ),
    );
  }
  if (run.error) lines.push(line({ text: 'Erreur : ' }, { code: truncate(run.error, ERROR_MAX) }));
  if (run.resultText) {
    lines.push(
      { ...line({ text: '' }), detail: true },
      { ...line({ text: truncate(run.resultText, RESULT_MAX) }), detail: true },
    );
  }

  return { lines };
}
