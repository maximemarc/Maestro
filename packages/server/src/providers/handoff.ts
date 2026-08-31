/**
 * Résumés de reprise (« handoff »).
 *
 * Deux moments, deux exigences :
 *
 *  - **au seuil**, avant le blocage : on a encore un fournisseur sous la main,
 *    donc le résumé peut être *raisonné* — un modèle relit le déroulé et écrit
 *    l'état du travail ;
 *  - **au blocage**, en filet de sécurité : par construction, il ne reste
 *    souvent plus personne pour rédiger. Le résumé est alors *mécanique*,
 *    reconstruit depuis les événements déjà persistés, et marqué `degraded`.
 *
 * Ce second cas n'est pas un repli théorique : c'est le cas fréquent. Quand
 * tous les comptes sont en quota, aucun ne peut résumer. Un résumé mécanique
 * signalé comme tel vaut mieux qu'une reprise à l'aveugle — et bien mieux
 * qu'un résumé absent parce qu'on avait supposé qu'un modèle serait toujours
 * joignable.
 */
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  API_BASE_URLS,
  type AgentConfig,
  type HandoffReason,
  type ProviderAccount,
  type Run,
  type RunEvent,
  type SessionHandoff,
} from '@maestro/shared';
import type { Bus } from '../bus.ts';
import type { Store } from '../db.ts';
import { makeId, nowIso, truncate } from '../util.ts';
import type { ProviderService } from './registry.ts';

/** Événements relus pour bâtir le résumé : la fin d'un run porte l'essentiel. */
const EVENTS_CONSIDERED = 60;
/** Longueur max du condensé envoyé au modèle résumeur. */
const DIGEST_MAX = 12_000;
/** Un résumé qui traîne bloquerait la bascule ; au-delà, on prend le mécanique. */
const SUMMARY_TIMEOUT_MS = 90_000;

const SUMMARY_INSTRUCTIONS = `Tu prépares la reprise d'un travail interrompu, par un autre assistant qui n'a
aucun accès à l'historique. Rends un texte structuré, en français, sans préambule ni conclusion :

## Objectif
Ce qui était demandé, en une ou deux phrases.

## Fait
Ce qui est acquis : fichiers modifiés, décisions prises, résultats obtenus. Sois factuel et précis.

## En cours
Ce qui était entamé au moment de l'interruption, et où ça en était exactement.

## Reste à faire
Les étapes suivantes, dans l'ordre.

## Pièges
Ce qui a déjà été essayé sans succès, et les contraintes à ne pas réapprendre.

Ne réinvente rien : si une information manque, écris « inconnu ». N'invente aucun chemin de fichier.`;

export class HandoffService {
  constructor(
    private store: Store,
    private bus: Bus,
    private providers: ProviderService,
  ) {}

  /**
   * Capture un résumé pour un run.
   *
   * `allowModel` à faux impose le résumé mécanique. C'est ce qu'on veut sur le
   * chemin du blocage : tenter un appel qui échouera à son tour retarderait la
   * bascule de plusieurs secondes pour rien.
   */
  async capture(input: {
    run: Run;
    agent: AgentConfig;
    reason: HandoffReason;
    tokensAtCapture: number;
    allowModel: boolean;
  }): Promise<SessionHandoff> {
    const { run, agent, reason, tokensAtCapture } = input;
    const events = this.store.listRunEvents(run.id).slice(-EVENTS_CONSIDERED);
    const digest = buildDigest(run, events);

    let summary = digest;
    let degraded = true;

    if (input.allowModel) {
      const written = await this.writeSummary(digest, agent);
      if (written) {
        summary = written;
        degraded = false;
      }
    }

    const handoff: SessionHandoff = {
      id: makeId('hof'),
      runId: run.id,
      agentId: agent.id,
      reason,
      summary,
      degraded,
      sourceKind: run.providerKind,
      sourceAccountId: run.accountId,
      sourceSessionId: run.sessionId,
      tokensAtCapture,
      createdAt: nowIso(),
    };
    this.store.insertHandoff(handoff);
    this.bus.publish({ type: 'handoff.created', payload: handoff });
    this.bus.log(
      degraded ? 'warn' : 'info',
      'handoff',
      `Résumé de reprise capturé pour ${run.id} (${reason})${degraded ? ' — mécanique, aucun modèle disponible' : ''}`,
      { agentId: agent.id, runId: run.id },
    );

    if (agent.memoryEnabled) this.appendToMemory(agent, handoff);
    return handoff;
  }

  /** Préambule à injecter dans le prompt d'une tentative qui reprend ailleurs. */
  static preamble(handoff: SessionHandoff): string {
    return [
      '# Reprise de session',
      '',
      handoff.degraded
        ? `Le travail ci-dessous a été interrompu (${handoff.reason}). Ce compte rendu est **reconstruit mécaniquement** depuis le journal d'exécution : il peut être incomplet ou mal ordonné. Vérifie l'état réel des fichiers avant d'agir.`
        : `Le travail ci-dessous a été interrompu (${handoff.reason}) puis résumé. Reprends là où il s'est arrêté.`,
      '',
      handoff.summary,
      '',
      '---',
      '',
      "Consigne de reprise : commence par constater l'état réel du dépôt avant de modifier quoi que ce soit. Ne recommence pas ce qui est déjà fait.",
      '',
    ].join('\n');
  }

  /**
   * Fait rédiger le résumé par un fournisseur encore disponible.
   *
   * Ordre de préférence : une API HTTP d'abord (un aller-retour, pas de session
   * agent à monter), puis un compte Claude en session nue — sans outil, sans
   * MCP, sur un modèle bon marché. Un résumé qui coûterait aussi cher que le
   * travail résumé n'aurait aucun intérêt.
   */
  private async writeSummary(digest: string, agent: AgentConfig): Promise<string | null> {
    const ready = this.providers.readyAccounts();
    const http = ready.find((a) => a.kind === 'http-api');
    if (http) {
      const text = await this.summarizeViaHttp(http, digest);
      if (text) return text;
    }
    const claude = ready.find((a) => a.kind === 'claude-sdk');
    if (claude || ready.length === 0) {
      const text = await this.summarizeViaSdk(claude ?? null, digest, agent);
      if (text) return text;
    }
    return null;
  }

  private async summarizeViaHttp(account: ProviderAccount, digest: string): Promise<string | null> {
    const flavor = account.apiFlavor ?? 'anthropic';
    const baseUrl = (account.baseUrl ?? API_BASE_URLS[flavor]).replace(/\/+$/, '');
    const envName = account.apiKeyEnv;
    const key = envName ? process.env[envName] : undefined;
    if (!key) return null;
    const model =
      account.model ?? (flavor === 'anthropic' ? 'claude-haiku-4-5-20251001' : 'gpt-4o-mini');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SUMMARY_TIMEOUT_MS);
    try {
      const res =
        flavor === 'anthropic'
          ? await fetch(`${baseUrl}/v1/messages`, {
              method: 'POST',
              signal: controller.signal,
              headers: {
                'content-type': 'application/json',
                'x-api-key': key,
                'anthropic-version': '2023-06-01',
              },
              body: JSON.stringify({
                model,
                max_tokens: 2000,
                system: SUMMARY_INSTRUCTIONS,
                messages: [{ role: 'user', content: digest }],
              }),
            })
          : await fetch(`${baseUrl}/v1/chat/completions`, {
              method: 'POST',
              signal: controller.signal,
              headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
              body: JSON.stringify({
                model,
                max_tokens: 2000,
                messages: [
                  { role: 'system', content: SUMMARY_INSTRUCTIONS },
                  { role: 'user', content: digest },
                ],
              }),
            });
      if (!res.ok) return null;
      const json = (await res.json()) as Record<string, unknown>;
      return extractApiText(json, flavor);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Session Claude nue, dédiée au résumé.
   *
   * `allowedTools: []` n'est pas une précaution de style : un résumeur qui
   * pourrait lire ou écrire dans le workspace irait fouiller au lieu de
   * résumer, et pourrait modifier l'état qu'il est censé décrire.
   */
  private async summarizeViaSdk(
    account: ProviderAccount | null,
    digest: string,
    agent: AgentConfig,
  ): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SUMMARY_TIMEOUT_MS);
    try {
      let text = '';
      for await (const message of query({
        prompt: `${SUMMARY_INSTRUCTIONS}\n\n---\n\n${digest}`,
        options: {
          model: account?.model ?? 'haiku',
          cwd: agent.workspaceDir,
          allowedTools: [],
          settingSources: [],
          permissionMode: 'default',
          abortController: controller,
          env: this.providers.envForAccount(account),
        },
      })) {
        if (message.type === 'result' && message.subtype === 'success') text = message.result;
      }
      return text.trim() || null;
    } catch (err) {
      this.bus.log(
        'warn',
        'handoff',
        `Résumé raisonné impossible : ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Ajoute le résumé au MEMORY.md de l'agent.
   *
   * C'est la réponse à « remplir la mémoire avant le blocage » : la mémoire
   * survit au run, donc à la limite d'usage. Un échec d'écriture ne fait pas
   * échouer la capture — le résumé est déjà en base, la mémoire n'est qu'une
   * commodité de relecture.
   */
  private appendToMemory(agent: AgentConfig, handoff: SessionHandoff): void {
    try {
      const path = join(agent.workspaceDir, 'MEMORY.md');
      const block = [
        '',
        `## Reprise ${handoff.createdAt} (run ${handoff.runId}, ${handoff.reason}${handoff.degraded ? ', résumé mécanique' : ''})`,
        '',
        handoff.summary,
        '',
      ].join('\n');
      appendFileSync(path, block, 'utf8');
    } catch (err) {
      this.bus.log(
        'warn',
        'handoff',
        `Mémoire non mise à jour pour « ${agent.name} » : ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/**
 * Condensé mécanique du déroulé d'un run.
 *
 * Sert deux fois : d'entrée au résumé raisonné, et de résumé de secours quand
 * plus aucun modèle n'est joignable. Le format est donc lisible par un humain
 * autant que par un modèle.
 */
export function buildDigest(run: Run, events: RunEvent[]): string {
  const lines: string[] = [];
  lines.push('# Journal d’exécution interrompu');
  lines.push('');
  lines.push(`Agent : ${run.agentId}`);
  lines.push(`Modèle : ${run.model} (${run.providerKind})`);
  lines.push(`Tours : ${run.numTurns} — tokens : ${run.inputTokens + run.outputTokens}`);
  lines.push('');
  lines.push('## Demande initiale');
  lines.push('');
  lines.push(truncate(run.prompt, 3000));
  lines.push('');

  const tools = new Map<string, number>();
  const narrative: string[] = [];
  for (const event of events) {
    const payload = event.payload;
    if (event.kind === 'tool_use' && payload.toolName) {
      tools.set(payload.toolName, (tools.get(payload.toolName) ?? 0) + 1);
      narrative.push(
        `- outil ${payload.toolName} : ${truncate(stringifyInput(payload.toolInput), 300)}`,
      );
    } else if (event.kind === 'assistant_text' && payload.text) {
      narrative.push(`- dit : ${truncate(payload.text, 600)}`);
    } else if (event.kind === 'tool_result' && payload.isError && payload.text) {
      narrative.push(`- ERREUR d’outil : ${truncate(payload.text, 400)}`);
    } else if (event.kind === 'error' && payload.text) {
      narrative.push(`- erreur : ${truncate(payload.text, 400)}`);
    }
  }

  if (tools.size > 0) {
    lines.push('## Outils utilisés');
    lines.push('');
    for (const [name, count] of [...tools.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`- ${name} × ${count}`);
    }
    lines.push('');
  }

  lines.push('## Déroulé (fin de session)');
  lines.push('');
  lines.push(...narrative);

  const text = lines.join('\n');
  return text.length > DIGEST_MAX ? `${text.slice(0, DIGEST_MAX)}\n\n…(condensé tronqué)` : text;
}

function stringifyInput(input: unknown): string {
  if (input === null || input === undefined) return '';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

function extractApiText(
  json: Record<string, unknown>,
  flavor: 'anthropic' | 'openai',
): string | null {
  if (flavor === 'anthropic') {
    const content = json.content;
    if (!Array.isArray(content)) return null;
    const text = content
      .map((block) =>
        typeof block === 'object' && block !== null && 'text' in block
          ? String((block as { text: unknown }).text)
          : '',
      )
      .join('')
      .trim();
    return text || null;
  }
  const choices = json.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0] as { message?: { content?: unknown } };
  const text = typeof first.message?.content === 'string' ? first.message.content.trim() : '';
  return text || null;
}
