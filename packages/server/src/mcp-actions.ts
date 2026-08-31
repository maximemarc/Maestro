/**
 * Actions de contrôle de l'orchestrateur, indépendantes du transport.
 *
 * Les mêmes gestes — créer une carte, la déplacer, déléguer, écrire en mémoire
 * — sont désormais accessibles par deux chemins : le serveur MCP in-process
 * d'un run SDK, et la passerelle MCP ouverte aux clients tiers. Ce module porte
 * la logique une seule fois.
 *
 * Ce n'est pas une factorisation de confort. La délégation contient les
 * garde-fous qui empêchent une boucle d'agents — profondeur maximale, refus de
 * l'auto-délégation, plafond de concurrence — et les dupliquer aurait garanti
 * qu'une des deux copies dérive. Un client Codex qui aurait échappé à la limite
 * de profondeur pourrait déclencher une cascade que rien n'arrête.
 */
import { KANBAN_COLUMNS, parseTarget, type AgentConfig, type KanbanColumn } from '@maestro/shared';
import type { AgentService } from './agents.ts';
import type { Bus } from './bus.ts';
import type { TaskService } from './kanban.ts';
import type { RunEngine } from './runs.ts';

export interface ControlDeps {
  tasks: TaskService;
  agents: AgentService;
  bus: Bus;
  engine: RunEngine;
  maxAgentDepth: () => number;
  /**
   * Délégation vers une autre instance. Optionnel : une instance sans pair
   * déclaré n'en a pas besoin, et les tests de contrôle s'en passent.
   */
  federation?: {
    delegate(input: {
      peerName: string;
      agentName: string;
      prompt: string;
      wait: boolean;
      hops: number;
      fromAgent: string;
    }): Promise<string>;
  };
}

/**
 * Au nom de qui, et depuis quel run, l'action est faite.
 *
 * `runId` n'est jamais nul : une action de contrôle sans run serait invisible
 * dans Mission Control et impossible à rattacher. Un client tiers en obtient un
 * par sa session externe.
 */
export interface ActionContext {
  runId: string;
  agent: AgentConfig;
  depth: number;
  /**
   * Sauts entre machines déjà effectués par cette chaîne de délégation.
   *
   * Distinct de `depth`, qui compte les délégations **dans** une instance : une
   * chaîne peut être profonde localement et n'avoir franchi aucune frontière,
   * ou l'inverse. Les confondre laisserait passer un aller-retour entre deux
   * machines à chaque niveau de profondeur.
   */
  federationHops?: number;
}

/** Erreur métier d'une action : message destiné au modèle, pas une panne. */
export class ActionError extends Error {}

export const TASK_CREATE_DESCRIPTION = 'Créer une carte dans le kanban partagé Maestro.';
export const TASK_UPDATE_DESCRIPTION =
  'Déplacer une carte du kanban et/ou y ajouter un commentaire de progression.';
export const SEND_TO_AGENT_DESCRIPTION =
  "Déléguer une sous-tâche à un autre agent Maestro, désigné par son nom. Par défaut la délégation est asynchrone ; avec wait=true, la réponse de l'agent est retournée directement (peut prendre plusieurs minutes). " +
  "Pour confier la tâche à un agent d'une autre instance Maestro, écris « agent@pair » — les pairs déclarés sont listés dans un message d'erreur si le nom est inconnu.";
export const MEMORY_SAVE_DESCRIPTION =
  "Consigner un fait durable dans la mémoire persistante de l'agent (MEMORY.md). Jamais de secret.";

/** Délai maximal d'attente d'une délégation bloquante. */
const DELEGATION_TIMEOUT_MS = 30 * 60 * 1000;

export function createTask(
  deps: ControlDeps,
  ctx: ActionContext,
  args: { title: string; description?: string; column?: KanbanColumn },
): string {
  const task = deps.tasks.create({
    title: args.title,
    description: args.description ?? '',
    column: args.column ?? 'backlog',
    agentId: ctx.agent.id,
  });
  return `Carte créée : ${task.id} (« ${task.title} », colonne ${task.column})`;
}

export function updateTask(
  deps: ControlDeps,
  ctx: ActionContext,
  args: { taskId: string; column?: KanbanColumn; comment?: string },
): string {
  const task = deps.tasks.get(args.taskId);
  if (!task) throw new ActionError(`Carte introuvable : ${args.taskId}`);

  let updated = task;
  if (args.comment) {
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    updated =
      deps.tasks.update(task.id, {
        description:
          `${task.description}\n\n> [${stamp} · ${ctx.agent.name}] ${args.comment}`.trim(),
      }) ?? updated;
  }
  if (args.column && args.column !== task.column) {
    updated =
      deps.tasks.move(task.id, args.column, Number.MAX_SAFE_INTEGER, ctx.agent.name) ?? updated;
  }
  return `Carte ${updated.id} à jour (colonne ${updated.column}).`;
}

export function saveMemory(
  deps: ControlDeps,
  ctx: ActionContext,
  args: { content: string },
): string {
  deps.agents.appendMemory(ctx.agent, args.content);
  return 'Mémoire mise à jour.';
}

/**
 * Délègue une sous-tâche à un autre agent.
 *
 * Porte les trois garde-fous anti-cascade : un agent ne se délègue pas à
 * lui-même, la profondeur est bornée, et seule une délégation bloquante dépasse
 * le plafond de concurrence — puisqu'elle seule occupe un slot en attendant.
 */
export async function delegate(
  deps: ControlDeps,
  ctx: ActionContext,
  args: { agentName: string; prompt: string; wait?: boolean },
): Promise<string> {
  /*
   * Cible fédérée : `agent@pair` part vers une autre instance.
   *
   * Traité avant la résolution locale, sinon un nom contenant une arobase
   * chercherait un agent local qui n'existe pas et rendrait « agent
   * introuvable » — le pire message possible, puisqu'il désigne la bonne cible.
   */
  const { agentName, peerName } = parseTarget(args.agentName);
  if (peerName) {
    if (!deps.federation) {
      throw new ActionError(
        'La fédération n’est pas disponible sur cette instance : aucune délégation entre machines.',
      );
    }
    try {
      return await deps.federation.delegate({
        peerName,
        agentName,
        prompt: args.prompt,
        wait: args.wait ?? false,
        hops: ctx.federationHops ?? 0,
        fromAgent: ctx.agent.name,
      });
    } catch (err) {
      /* Une erreur de fédération est un message pour le modèle — pair inconnu,
         disjoncteur ouvert, plafond atteint — pas une panne du serveur. */
      throw new ActionError(err instanceof Error ? err.message : String(err));
    }
  }

  const target = deps.agents.getByName(agentName);
  if (!target) {
    const names = deps.agents
      .list()
      .map((a) => a.name)
      .join(', ');
    throw new ActionError(`Agent « ${args.agentName} » introuvable. Agents disponibles : ${names}`);
  }
  if (target.id === ctx.agent.id) {
    throw new ActionError('Un agent ne peut pas se déléguer une tâche à lui-même.');
  }
  if (ctx.depth >= deps.maxAgentDepth()) {
    throw new ActionError(`Profondeur de délégation maximale atteinte (${ctx.depth}).`);
  }

  const wait = args.wait ?? false;
  let run;
  try {
    run = deps.engine.start({
      agentId: target.id,
      prompt: `Tâche déléguée par l'agent « ${ctx.agent.name} » :\n\n${args.prompt}`,
      origin: 'agent',
      originId: ctx.runId,
      parentRunId: ctx.runId,
      depth: ctx.depth + 1,
      bypassConcurrencyCap: wait,
    });
  } catch (err) {
    throw new ActionError(err instanceof Error ? err.message : String(err));
  }

  deps.bus.log('info', 'delegation', `${ctx.agent.name} → ${target.name} (${run.id})`, {
    agentId: ctx.agent.id,
    runId: ctx.runId,
  });

  if (!wait) {
    return `Délégation lancée : run ${run.id} confié à « ${target.name} ». Le résultat sera visible dans Maestro (tu n'attends pas la réponse).`;
  }

  const finished = await deps.engine.waitForRun(run.id, DELEGATION_TIMEOUT_MS);
  if (!finished) {
    throw new ActionError(`Le run délégué ${run.id} n'a pas terminé dans le délai imparti.`);
  }
  if (finished.status !== 'succeeded') {
    throw new ActionError(
      `Le run délégué ${run.id} s'est terminé en « ${finished.status} »${finished.error ? ` : ${finished.error}` : ''}.`,
    );
  }
  return `Réponse de « ${target.name} » :\n\n${finished.resultText ?? '(aucun texte de résultat)'}`;
}

/** Colonnes acceptées, exposées aux deux transports pour rester cohérentes. */
export const COLUMNS = KANBAN_COLUMNS;
