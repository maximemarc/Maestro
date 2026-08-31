#!/usr/bin/env node
/**
 * Assistant de configuration — écrit `.env.local`.
 *
 * Jusqu'ici il fallait lire `.env.example`, comprendre quelles variables
 * comptent, et les exporter à la main dans son shell. L'assistant pose les
 * quatre questions qui changent quelque chose et laisse le reste tranquille.
 *
 * Il n'écrase jamais un fichier existant sans le dire, et n'affiche aucun
 * secret déjà en place : un assistant qui recrache un jeton dans un terminal
 * partagé le divulgue.
 *
 * Usage : node scripts/setup.mjs   (ou `npm run setup`)
 */
import { createInterface } from 'node:readline/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { stdin, stdout } from 'node:process';

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const ENV_PATH = join(ROOT, '.env.local');

/*
 * Entrée non interactive : on refuse, on ne devine pas.
 *
 * `readline` reçoit la fin de flux avant d'avoir posé ses dernières questions,
 * et leurs promesses ne se résolvent jamais : le script reste pendu sans rien
 * afficher. Le cas se produit sous `curl | bash`, en CI, ou dans un
 * orchestrateur. Un message qui dit quoi faire vaut mieux qu'un processus figé.
 */
if (!stdin.isTTY) {
  stdout.write(
    [
      '',
      '  L’assistant a besoin d’un terminal interactif.',
      '',
      `  Sans terminal, écrire directement ${ENV_PATH} en s’inspirant de .env.example`,
      '  — les variables sont les mêmes. Un fichier absent est valable aussi : Maestro',
      '  engendre alors son jeton au premier démarrage.',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

const rl = createInterface({ input: stdin, output: stdout });

/** Lit une réponse, en proposant un défaut entre crochets. */
async function ask(question, fallback = '') {
  const suffix = fallback ? ` [${fallback}]` : '';
  const answer = (await rl.question(`  ${question}${suffix} : `)).trim();
  return answer || fallback;
}

async function askYesNo(question, fallback = false) {
  const answer = (await ask(`${question} (o/n)`, fallback ? 'o' : 'n')).toLowerCase();
  return answer.startsWith('o') || answer.startsWith('y');
}

/**
 * Relit le fichier existant.
 *
 * Les valeurs déjà présentes servent de défauts, ce qui rend l'assistant
 * rejouable : on le relance pour changer une seule chose sans retaper le reste.
 */
function readExisting() {
  if (!existsSync(ENV_PATH)) return {};
  const values = {};
  for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    values[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return values;
}

/** Masque une valeur sensible pour l'affichage — jamais en clair. */
function masked(value) {
  if (!value) return '(absent)';
  return `${value.slice(0, 3)}…${value.slice(-2)} (${value.length} caractères)`;
}

function quote(value) {
  // Guillemets seulement si nécessaire : un fichier lisible se relit à l'œil.
  return /[\s#"']/.test(value) ? JSON.stringify(value) : value;
}

async function main() {
  stdout.write('\n  🎛  Configuration de Maestro\n\n');

  const existing = readExisting();
  if (Object.keys(existing).length > 0) {
    stdout.write(`  Un .env.local existe déjà — ses valeurs servent de défauts.\n\n`);
  }

  const port = await ask('Port HTTP', existing.MAESTRO_PORT ?? '4520');
  const dataDir = await ask(
    'Répertoire de données',
    existing.MAESTRO_DATA_DIR ?? join(homedir(), '.maestro'),
  );

  // -- Jeton ---------------------------------------------------------------
  let token = existing.MAESTRO_TOKEN ?? '';
  if (token) {
    stdout.write(`\n  Jeton actuel : ${masked(token)}\n`);
    if (await askYesNo('Le remplacer par un nouveau jeton engendré', false)) {
      token = randomBytes(24).toString('base64url');
      stdout.write('  Nouveau jeton engendré.\n');
    }
  } else {
    stdout.write('\n');
    if (await askYesNo('Engendrer un jeton d’accès maintenant', true)) {
      token = randomBytes(24).toString('base64url');
    } else {
      stdout.write(
        '  Sans jeton ici, Maestro en engendre un au premier démarrage et l’écrit\n' +
          `  dans ${join(dataDir, 'token')}.\n`,
      );
    }
  }

  // -- Telegram ------------------------------------------------------------
  let telegramToken = existing.TELEGRAM_BOT_TOKEN ?? '';
  let telegramChats = existing.TELEGRAM_CHAT_IDS ?? '';
  stdout.write('\n');
  if (await askYesNo('Configurer le bot Telegram', Boolean(telegramToken))) {
    telegramToken = await ask('Jeton du bot (@BotFather)', telegramToken);
    telegramChats = await ask(
      'Identifiants de chat autorisés, séparés par des virgules',
      telegramChats,
    );
    if (telegramToken && !telegramChats) {
      // 🔒 Un bot sans liste blanche répond à n'importe qui : le dire, et ne pas
      // laisser croire que la configuration est complète.
      stdout.write(
        '  ⚠ Sans identifiant de chat, aucun message n’est accepté. La liste blanche\n' +
          '    est stricte, et c’est délibéré : un bot ouvert exécute des agents pour\n' +
          '    n’importe qui.\n',
      );
    }
  }

  // -- Embeddings ----------------------------------------------------------
  let voyage = existing.VOYAGE_API_KEY ?? '';
  let openai = existing.OPENAI_API_KEY ?? '';
  stdout.write('\n');
  if (
    await askYesNo(
      'Activer la recherche sémantique du RAG (clé d’embeddings)',
      Boolean(voyage || openai),
    )
  ) {
    stdout.write('  Sans clé, la recherche reste lexicale (BM25) et fonctionne hors ligne.\n');
    voyage = await ask('Clé Voyage (laisser vide pour ignorer)', voyage);
    if (!voyage) openai = await ask('Clé OpenAI (laisser vide pour ignorer)', openai);
  }

  // -- Écriture ------------------------------------------------------------
  const lines = [
    '# Configuration locale de Maestro — engendrée par `npm run setup`.',
    '# 🔒 Ce fichier contient des secrets : il n’est pas versionné (voir .gitignore).',
    '',
    `MAESTRO_PORT=${quote(port)}`,
    `MAESTRO_DATA_DIR=${quote(dataDir)}`,
  ];
  if (token) lines.push(`MAESTRO_TOKEN=${quote(token)}`);
  if (telegramToken) {
    lines.push('', `TELEGRAM_BOT_TOKEN=${quote(telegramToken)}`);
    if (telegramChats) lines.push(`TELEGRAM_CHAT_IDS=${quote(telegramChats)}`);
  }
  if (voyage) lines.push('', `VOYAGE_API_KEY=${quote(voyage)}`);
  else if (openai) lines.push('', `OPENAI_API_KEY=${quote(openai)}`);
  lines.push('');

  writeFileSync(ENV_PATH, lines.join('\n'), { mode: 0o600 });

  stdout.write(`\n  ✓ Écrit dans ${ENV_PATH} (permissions 600).\n\n`);
  stdout.write('  Démarrer :\n');
  stdout.write('    npm run build && npm start\n\n');
  stdout.write(`  Puis ouvrir http://localhost:${port}\n`);
  if (token) stdout.write(`  Jeton : ${masked(token)} — il est dans .env.local.\n`);
  stdout.write('\n');
}

try {
  await main();
} finally {
  rl.close();
}
