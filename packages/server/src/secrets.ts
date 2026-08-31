/**
 * Chiffrement des secrets au repos.
 *
 * Les jetons des serveurs MCP — clé GitHub, clé Brave, en-têtes
 * d'authentification — étaient masqués à la lecture de l'API mais stockés en
 * clair dans la base. Qui lisait `maestro.db` lisait donc les clés : une
 * sauvegarde recopiée, un disque non chiffré, un dump partagé pour déboguer
 * suffisaient à les divulguer, et rien ne le signalait.
 *
 * AES-256-GCM, clé dans un fichier séparé en 0600. Séparer la clé de la base
 * est ce qui fait tout l'intérêt : les deux ne voyagent pas ensemble, et une
 * sauvegarde seule ne suffit plus.
 *
 * ⚠️ Ce n'est pas une protection contre un attaquant qui a déjà le compte de
 * l'utilisateur — il lira les deux fichiers. Ça protège la base *sortie de son
 * contexte* : copiée, sauvegardée, transmise.
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Préfixe qui distingue une valeur chiffrée d'une valeur héritée en clair. */
const PREFIX = 'enc.v1.';
const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;

export interface SecretBox {
  encrypt(plain: string): string;
  decrypt(stored: string): string;
}

/**
 * Coffre neutre : ne chiffre rien.
 *
 * Employé quand aucun répertoire de données n'est disponible — les tests, qui
 * travaillent en mémoire. Il déchiffre malgré tout les valeurs marquées : sans
 * cela, un test lisant une base chiffrée rendrait du charabia au lieu d'échouer
 * franchement.
 */
export function passthroughBox(): SecretBox {
  return {
    encrypt: (plain) => plain,
    decrypt: (stored) => stored,
  };
}

/**
 * Charge la clé, ou en crée une.
 *
 * 🔒 Le fichier est écrit en 0600 et son mode est réaffirmé à chaque lecture :
 * une clé lisible par tout le monde n'en est plus une, et un `umask` permissif
 * ou une copie maladroite suffit à élargir les droits sans qu'on le remarque.
 */
function loadKey(dataDir: string): Buffer {
  const path = join(dataDir, 'secret.key');
  if (existsSync(path)) {
    const key = readFileSync(path);
    if (key.length !== KEY_BYTES) {
      throw new Error(
        `Clé de chiffrement invalide dans ${path} (${key.length} octets au lieu de ${KEY_BYTES}). ` +
          `La restaurer depuis une sauvegarde : sans elle, les secrets enregistrés sont illisibles.`,
      );
    }
    chmodSync(path, 0o600);
    return key;
  }
  const key = randomBytes(KEY_BYTES);
  writeFileSync(path, key, { mode: 0o600 });
  return key;
}

export function createSecretBox(dataDir: string): SecretBox {
  const key = loadKey(dataDir);

  return {
    encrypt(plain: string): string {
      // Une chaîne vide reste vide : la chiffrer produirait une valeur non nulle
      // pour une absence de valeur, ce qui rend l'affichage trompeur.
      if (plain === '') return '';
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `${PREFIX}${iv.toString('base64')}.${tag.toString('base64')}.${body.toString('base64')}`;
    },

    /**
     * Déchiffre, ou rend la valeur telle quelle.
     *
     * Les valeurs enregistrées avant l'existence de ce module sont en clair et
     * n'ont pas le préfixe : les rendre inchangées est ce qui permet
     * d'introduire le chiffrement sans migration ni perte. Elles se
     * rechiffrent à la première modification du serveur concerné.
     */
    decrypt(stored: string): string {
      if (!stored.startsWith(PREFIX)) return stored;
      const [ivPart, tagPart, bodyPart] = stored.slice(PREFIX.length).split('.');
      if (!ivPart || !tagPart || !bodyPart) return '';
      try {
        const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivPart, 'base64'));
        decipher.setAuthTag(Buffer.from(tagPart, 'base64'));
        return Buffer.concat([
          decipher.update(Buffer.from(bodyPart, 'base64')),
          decipher.final(),
        ]).toString('utf8');
      } catch {
        /*
         * Clé changée, ou valeur altérée : GCM le détecte et lève. On rend une
         * chaîne vide plutôt que de propager — un serveur MCP qui échoue à
         * s'authentifier est réparable, un orchestrateur qui refuse de démarrer
         * parce qu'une clé d'API est illisible ne l'est pas.
         */
        return '';
      }
    },
  };
}

/** Vrai si la valeur porte la marque du chiffrement. */
export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

export function encryptMap(box: SecretBox, map: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, box.encrypt(v)]));
}

export function decryptMap(box: SecretBox, map: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, box.decrypt(v)]));
}

/**
 * Comparaison à durée constante de deux secrets.
 *
 * Exposée ici parce que c'est le module des secrets ; employée partout où l'on
 * compare une valeur fournie à une valeur attendue.
 */
export function secretsEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
