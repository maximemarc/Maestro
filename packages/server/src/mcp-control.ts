/**
 * Serveur MCP in-process « maestro » exposé à chaque run SDK.
 * C'est le canal officiel par lequel les agents agissent sur l'orchestrateur :
 * kanban, délégation inter-agents, mémoire, rapport final.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { KANBAN_COLUMNS, type AgentConfig } from '@maestro/shared';
import type { AgentService } from './agents.ts';
import type { Bus } from './bus.ts';
import type { TaskService } from './kanban.ts';
import type { RunEngine } from './runs.ts';
import type { SkillRegistry } from './skills.ts';
import { truncate } from './util.ts';

export interface ControlDeps {
  tasks: TaskService;
  agents: AgentService;
  bus: Bus;
  engine: RunEngine;
  /** Registre des skills — l'agent y consigne ses méthodes réutilisables. */
  skills: SkillRegistry;
  maxAgentDepth: () => number;
}

export interface RunContext {
  runId: string;
  agent: AgentConfig;
  depth: number;
}

function text(message: string) {
  return { content: [{ type: 'text' as const, text: message }] };
}

function error(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

export function buildMaestroServer(deps: ControlDeps, ctx: RunContext) {
  const taskCreate = tool(
    'task_create',
    'Créer une carte dans le kanban partagé Maestro.',
    {
      title: z.string().min(1).max(200),
      description: z.string().max(4000).default(''),
      column: z.enum(KANBAN_COLUMNS).default('backlog'),
    },
    async (args) => {
      const task = deps.tasks.create({
        title: args.title,
        description: args.description,
        column: args.column,
        agentId: ctx.agent.id,
      });
      return text(`Carte créée : ${task.id} (« ${task.title} », colonne ${task.column})`);
    },
  );

  const taskUpdate = tool(
    'task_update',
    'Déplacer une carte du kanban et/ou y ajouter un commentaire de progression.',
    {
      taskId: z.string(),
      column: z.enum(KANBAN_COLUMNS).optional(),
      comment: z.string().max(2000).optional(),
    },
    async (args) => {
      const task = deps.tasks.get(args.taskId);
      if (!task) return error(`Carte introuvable : ${args.taskId}`);
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
      return text(`Carte ${updated.id} à jour (colonne ${updated.column}).`);
    },
  );

  const sendToAgent = tool(
    'send_to_agent',
    "Déléguer une sous-tâche à un autre agent Maestro, désigné par son nom. Par défaut la délégation est asynchrone ; avec wait=true, la réponse de l'agent est retournée directement (peut prendre plusieurs minutes).",
    {
      agentName: z.string(),
      prompt: z.string().min(1),
      wait: z.boolean().default(false),
    },
    async (args) => {
      const target = deps.agents.getByName(args.agentName);
      if (!target) {
        const names = deps.agents
          .list()
          .map((a) => a.name)
          .join(', ');
        return error(`Agent « ${args.agentName} » introuvable. Agents disponibles : ${names}`);
      }
      if (target.id === ctx.agent.id)
        return error('Un agent ne peut pas se déléguer une tâche à lui-même.');
      if (ctx.depth >= deps.maxAgentDepth()) {
        return error(`Profondeur de délégation maximale atteinte (${ctx.depth}).`);
      }
      let run;
      try {
        run = deps.engine.start({
          agentId: target.id,
          prompt: `Tâche déléguée par l'agent « ${ctx.agent.name} » :\n\n${args.prompt}`,
          origin: 'agent',
          originId: ctx.runId,
          parentRunId: ctx.runId,
          depth: ctx.depth + 1,
          // Seule une délégation bloquante occupe un slot en attendant : elle
          // seule doit pouvoir dépasser le plafond. Sinon, le plafond borne le fan-out.
          bypassConcurrencyCap: args.wait,
        });
      } catch (err) {
        return error(err instanceof Error ? err.message : String(err));
      }
      deps.bus.log('info', 'delegation', `${ctx.agent.name} → ${target.name} (${run.id})`, {
        agentId: ctx.agent.id,
        runId: ctx.runId,
      });
      if (!args.wait) {
        return text(
          `Délégation lancée : run ${run.id} confié à « ${target.name} ». Le résultat sera visible dans Maestro (tu n'attends pas la réponse).`,
        );
      }
      const finished = await deps.engine.waitForRun(run.id, 30 * 60 * 1000);
      if (!finished)
        return error(`Le run délégué ${run.id} n'a pas terminé dans le délai imparti.`);
      if (finished.status !== 'succeeded') {
        return error(
          `Le run délégué ${run.id} s'est terminé en « ${finished.status} »${finished.error ? ` : ${finished.error}` : ''}.`,
        );
      }
      return text(
        `Réponse de « ${target.name} » :\n\n${finished.resultText ?? '(aucun texte de résultat)'}`,
      );
    },
  );

  const memorySave = tool(
    'memory_save',
    "Consigner un fait durable dans la mémoire persistante de l'agent (MEMORY.md). Jamais de secret.",
    {
      content: z.string().min(1).max(4000),
    },
    async (args) => {
      deps.agents.appendMemory(ctx.agent, args.content);
      return text('Mémoire mise à jour.');
    },
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
    {
      summary: z.string().min(1).max(20000),
    },
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
