import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from './db.ts';
import {
  createSecretBox,
  decryptMap,
  encryptMap,
  isEncrypted,
  passthroughBox,
  secretsEqual,
} from './secrets.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'maestro-secrets-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('coffre', () => {
  it('fait l’aller-retour sur une valeur', () => {
    const box = createSecretBox(dir);
    const clair = 'ghp_jeton_de_test_1234567890';
    const chiffre = box.encrypt(clair);
    expect(chiffre).not.toContain(clair);
    expect(box.decrypt(chiffre)).toBe(clair);
  });

  it('marque la valeur chiffrée', () => {
    const box = createSecretBox(dir);
    expect(isEncrypted(box.encrypt('x'))).toBe(true);
    expect(isEncrypted('x')).toBe(false);
  });

  /* Chiffrer une absence produirait une valeur non nulle pour rien, et
     l'affichage montrerait une clé là où il n'y en a pas. */
  it('laisse une chaîne vide inchangée', () => {
    const box = createSecretBox(dir);
    expect(box.encrypt('')).toBe('');
    expect(box.decrypt('')).toBe('');
  });

  it('produit un chiffré différent à chaque fois', () => {
    const box = createSecretBox(dir);
    /* Vecteur d'initialisation aléatoire : deux clés identiques ne doivent pas
       se reconnaître dans la base. */
    expect(box.encrypt('même-valeur')).not.toBe(box.encrypt('même-valeur'));
  });

  it('gère l’UTF-8 et les valeurs longues', () => {
    const box = createSecretBox(dir);
    const valeur = `clé-éàü-${'x'.repeat(5000)}`;
    expect(box.decrypt(box.encrypt(valeur))).toBe(valeur);
  });

  /*
   * Migration sans perte : les valeurs enregistrées avant l'existence du
   * chiffrement n'ont pas le préfixe. Les rendre inchangées est ce qui permet
   * d'introduire le chiffrement sans rien casser.
   */
  it('rend une valeur héritée en clair telle quelle', () => {
    expect(createSecretBox(dir).decrypt('ancienne-clé-en-clair')).toBe('ancienne-clé-en-clair');
  });

  it('rend vide plutôt que de lever sur une valeur altérée', () => {
    const box = createSecretBox(dir);
    const chiffre = box.encrypt('secret');
    const altere = `${chiffre.slice(0, -4)}AAAA`;
    // GCM détecte l'altération. Un orchestrateur qui refuse de démarrer parce
    // qu'une clé d'API est illisible est pire qu'un serveur MCP qui échoue.
    expect(box.decrypt(altere)).toBe('');
  });

  it('rend vide quand la clé a changé', () => {
    const chiffre = createSecretBox(dir).encrypt('secret');
    const autre = mkdtempSync(join(tmpdir(), 'maestro-autre-'));
    try {
      expect(createSecretBox(autre).decrypt(chiffre)).toBe('');
    } finally {
      rmSync(autre, { recursive: true, force: true });
    }
  });
});

describe('fichier de clé', () => {
  it('crée la clé en 0600', () => {
    createSecretBox(dir);
    const mode = statSync(join(dir, 'secret.key')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('réutilise la clé existante', () => {
    const chiffre = createSecretBox(dir).encrypt('stable');
    expect(createSecretBox(dir).decrypt(chiffre)).toBe('stable');
  });

  /* Un umask permissif ou une copie maladroite élargit les droits sans qu'on le
     remarque : le mode est réaffirmé à chaque lecture. */
  it('resserre les droits d’une clé devenue lisible', () => {
    createSecretBox(dir);
    const path = join(dir, 'secret.key');
    writeFileSync(path, readFileSync(path), { mode: 0o644 });
    createSecretBox(dir);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('refuse une clé de taille invalide plutôt que de chiffrer avec', () => {
    writeFileSync(join(dir, 'secret.key'), 'trop court', { mode: 0o600 });
    expect(() => createSecretBox(dir)).toThrow(/invalide/);
  });
});

describe('cartes de secrets', () => {
  it('chiffre et déchiffre chaque valeur en conservant les clés', () => {
    const box = createSecretBox(dir);
    const map = { GITHUB_TOKEN: 'ghp_x', BRAVE_API_KEY: 'brv_y' };
    const chiffree = encryptMap(box, map);
    expect(Object.keys(chiffree)).toEqual(Object.keys(map));
    expect(chiffree.GITHUB_TOKEN).not.toBe('ghp_x');
    expect(decryptMap(box, chiffree)).toEqual(map);
  });

  it('le coffre neutre ne transforme rien', () => {
    const box = passthroughBox();
    expect(encryptMap(box, { A: 'x' })).toEqual({ A: 'x' });
  });
});

describe('secrets en base', () => {
  /*
   * L'invariant : la base ne doit plus contenir la clé en clair. C'est tout
   * l'objet du chiffrement — une sauvegarde copiée ou un dump partagé pour
   * déboguer ne divulgue plus les jetons.
   */
  it('écrit le jeton chiffré et le relit en clair', () => {
    const dbPath = join(dir, 'test.db');
    const box = createSecretBox(dir);
    const store = new Store(dbPath, box);
    const now = '2026-08-28T09:00:00.000Z';

    store.upsertMcpServer({
      id: 'mcp_1',
      slug: 'github',
      name: 'GitHub',
      description: '',
      kind: 'external',
      enabled: true,
      transport: 'stdio',
      command: 'npx',
      args: [],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_secret_a_ne_pas_divulguer' },
      url: null,
      headers: { Authorization: 'Bearer xyz' },
      tools: [],
      createdAt: now,
      updatedAt: now,
    });

    // Relecture par le Store : en clair, comme le SDK l'attend.
    const relu = store.getMcpServer('mcp_1');
    expect(relu?.env.GITHUB_PERSONAL_ACCESS_TOKEN).toBe('ghp_secret_a_ne_pas_divulguer');
    expect(relu?.headers.Authorization).toBe('Bearer xyz');
    store.close();

    // Lecture du fichier lui-même : le jeton n'y figure plus.
    const brut = readFileSync(dbPath, 'latin1');
    expect(brut).not.toContain('ghp_secret_a_ne_pas_divulguer');
    expect(brut).not.toContain('Bearer xyz');
    expect(brut).toContain('enc.v1.');
  });
});

describe('comparaison de secrets', () => {
  it('reconnaît deux valeurs identiques', () => {
    expect(secretsEqual('jeton', 'jeton')).toBe(true);
  });

  it('rejette une valeur différente ou de longueur différente', () => {
    expect(secretsEqual('jeton', 'jetonx')).toBe(false);
    expect(secretsEqual('jeton', 'autre')).toBe(false);
    expect(secretsEqual('', 'x')).toBe(false);
  });
});
