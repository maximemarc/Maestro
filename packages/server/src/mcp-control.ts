/**
 * Serveur MCP in-process « maestro » exposé à chaque run SDK.
 * C'est le canal officiel par lequel les agents agissent sur l'orchestrateur :
 * kanban, délégation inter-agents, mémoire, rapport final.
 *
 * La logique des actions n'est pas ici : elle vit dans `mcp-actions.ts`, parce
 * que la passerelle MCP l'expose aussi aux clients tiers. Ce fichier ne fait
 * que l'habiller pour le SDK — schéma des arguments et forme du résultat.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { KANBAN_COLUMNS } from '@maestro/shared';
import {
  ActionError,
  createTask,
  delegate,
  MEMORY_SAVE_DESCRIPTION,
  saveMemory,
  SEND_TO_AGENT_DESCRIPTION,
  TASK_CREATE_DESCRIPTION,
  TASK_UPDATE_DESCRIPTION,
  updateTask,
  type ActionContext,
  type ControlDeps,
} from './mcp-actions.ts';
import { truncate } from './util.ts';

export type { ControlDeps } from './mcp-actions.ts';

/** Contexte d'un run SDK : identique à celui des actions partagées. */
export type RunContext = ActionContext;

function text(message: string) {
  return { content: [{ type: 'text' as const, text: message }] };
}

function error(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

/**
 * Exécute une action et traduit son erreur métier en résultat d'outil.
 *
 * Une `ActionError` s'adresse au modèle — carte introuvable, profondeur
 * atteinte — et doit lui revenir pour qu'il corrige. Toute autre exception est
 * une panne : elle remonte, et le moteur la traite comme un échec de run.
 */
async function run(fn: () => string | Promise<string>) {
  try {
    return text(await fn());
  } catch (err) {
    if (err instanceof ActionError) return error(err.message);
    throw err;
  }
}

export function buildMaestroServer(deps: ControlDeps, ctx: RunContext) {
  const taskCreate = tool(
    'task_create',
    TASK_CREATE_DESCRIPTION,
    {
      title: z.string().min(1).max(200),
      description: z.string().max(4000).default(''),
      column: z.enum(KANBAN_COLUMNS).default('backlog'),
    },
    async (args) => run(() => createTask(deps, ctx, args)),
  );

  const taskUpdate = tool(
    'task_update',
    TASK_UPDATE_DESCRIPTION,
    {
      taskId: z.string(),
      column: z.enum(KANBAN_COLUMNS).optional(),
      comment: z.string().max(2000).optional(),
    },
    async (args) => run(() => updateTask(deps, ctx, args)),
  );

  const sendToAgent = tool(
    'send_to_agent',
    SEND_TO_AGENT_DESCRIPTION,
    {
      agentName: z.string(),
      prompt: z.string().min(1),
      wait: z.boolean().default(false),
    },
    async (args) => run(() => delegate(deps, ctx, args)),
  );

  const memorySave = tool(
    'memory_save',
    MEMORY_SAVE_DESCRIPTION,
    { content: z.string().min(1).max(4000) },
    async (args) => run(() => saveMemory(deps, ctx, args)),
  );

  /*
   * Capitalisation d'une solution en skill réutilisable.
   *
   * C'est ce qui distingue un agent qui refait le même chemin à chaque fois d'un
   * agent qui apprend : la mémoire retient un fait, la skill retient une
   * méthode. Sans cet outil, un agent pouvait écrire un fichier dans son
   * workspace, mais rien ne le remontait au registre — la synchronisation ne va
   * que du registre vers les workspaces, jamais l'inverse.
   *
   * 🔒 Portée agent, toujours. Laisser un agent écrire une skill globale lui
   * donnerait le pouvoir de modifier le comportement de tous les autres, à leur
   * insu et sans validation. La promotion en global reste un geste humain, dans
   * l'interface.
   */
  const skillSave = tool(
    'skill_save',
    "Enregistrer une méthode réutilisable comme skill de cet agent, pour ne pas la redécouvrir à la prochaine tâche. À appeler quand un problème non trivial vient d'être résolu et que la démarche est généralisable. Jamais de secret ni de donnée personnelle dans le contenu.",
    {
      name: z.string().min(1).max(80),
      description: z
        .string()
        .min(1)
        .max(300)
        .describe('Quand employer cette skill — c’est ce qui décide de son déclenchement.'),
      content: z
        .string()
        .min(1)
        .max(20000)
        .describe('Le corps en markdown : démarche, pièges, exemples.'),
      slug: z.string().max(80).optional(),
    },
    async (args) => {
      try {
        const skill = deps.skills.upsert({
          scope: 'agent',
          agentId: ctx.agent.id,
          slug: args.slug ?? args.name,
          name: args.name,
          description: args.description,
          content: args.content,
        });
        deps.bus.log(
          'success',
          'skills',
          `${ctx.agent.name} a consigné la skill « ${skill.name} »`,
          {
            agentId: ctx.agent.id,
            runId: ctx.runId,
          },
        );
        return text(
          `Skill « ${skill.name} » enregistrée (${skill.id}). Elle est disponible dès le prochain run de cet agent.`,
        );
      } catch (err) {
        return error(
          `Enregistrement impossible : ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );

  const report = tool(
    'report',
    'Publier le résumé final structuré du travail effectué. À appeler une fois, en fin de tâche.',
    { summary: z.string().min(1).max(20000) },
    async (args) => {
      deps.engine.setRunReport(ctx.runId, args.summary);
      deps.bus.log('info', 'report', truncate(`${ctx.agent.name} : ${args.summary}`, 200), {
        agentId: ctx.agent.id,
        runId: ctx.runId,
      });
      return text('Rapport enregistré.');
    },
  );

  return createSdkMcpServer({
    name: 'maestro',
    version: '1.0.0',
    tools: [taskCreate, taskUpdate, sendToAgent, memorySave, skillSave, report],
  });
}
