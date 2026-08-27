/**
 * Assemblage d'un serveur MCP in-process à partir d'une définition saisie dans
 * l'interface.
 *
 * C'est la moitié « exécution » du MCP simplifié : le registre valide et
 * stocke, ce module traduit. Une définition devient un vrai serveur MCP, avec
 * de vrais schémas de paramètres — le modèle voit exactement la même chose que
 * pour un serveur écrit à la main.
 *
 * Les outils restent soumis au contrôle de permission de Maestro : ils
 * s'appellent `mcp__<slug>__<outil>`, donc la politique d'approbation de
 * l'agent s'applique sans traitement particulier.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerDef } from '@maestro/shared';
import type { Bus } from './bus.ts';
import { runAction } from './mcp-registry.ts';
import { toolSchema } from './mcp-schema.ts';

/**
 * Construit le serveur d'une définition maison.
 *
 * Le nom du serveur MCP est le slug : c'est lui qui apparaît dans le nom
 * d'outil vu par le modèle et dans les journaux d'approbation.
 */
export function buildCustomServer(def: McpServerDef, bus: Bus) {
  const tools = def.tools.map((toolDef) =>
    tool(toolDef.name, toolDef.description, toolSchema(toolDef), async (args) => {
      try {
        const output = await runAction(toolDef, args as Record<string, unknown>);
        return { content: [{ type: 'text' as const, text: output }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        /* L'échec est journalisé côté Maestro ET renvoyé au modèle : sans le
           journal, un outil qui échoue en boucle reste invisible ; sans le
           retour au modèle, l'agent réessaie sans comprendre. */
        bus.log('warn', 'mcp', `Outil ${def.slug}.${toolDef.name} en échec : ${message}`);
        return {
          content: [{ type: 'text' as const, text: `Échec de l'outil : ${message}` }],
          isError: true,
        };
      }
    }),
  );

  return createSdkMcpServer({ name: def.slug, version: '1.0.0', tools });
}
