/**
 * Priorité de la file d'attente.
 *
 * La dérivation depuis l'origine est le point qui décide de tout : si un
 * échantillon de lot était classé « normal », il occuperait le plafond comme
 * n'importe quel run, et la réservation d'une place pour l'interactif ne
 * servirait plus à rien.
 */
import { describe, expect, it } from 'vitest';
import { priorityForOrigin } from './runs.ts';

describe('priorité déduite de l’origine', () => {
  /* L'origine dit si quelqu'un attend devant son écran — c'est le seul critère
     dont Maestro dispose sans demander à l'utilisateur de classer ses runs. */
  it('classe interactif ce qu’un humain lance et regarde', () => {
    expect(priorityForOrigin('manual')).toBe('interactive');
    expect(priorityForOrigin('telegram')).toBe('interactive');
    expect(priorityForOrigin('discord')).toBe('interactive');
    expect(priorityForOrigin('slack')).toBe('interactive');
    // Le kanban en fait partie : on confie une carte et on regarde la colonne.
    expect(priorityForOrigin('kanban')).toBe('interactive');
  });

  it('classe en fond les échantillons de lot', () => {
    expect(priorityForOrigin('training')).toBe('background');
  });

  /* Une routine cron n'a personne devant elle, mais elle reste une tâche
     attendue à l'heure dite : la reléguer au fond la ferait rater son créneau. */
  it('laisse le reste en priorité normale', () => {
    expect(priorityForOrigin('routine')).toBe('normal');
    expect(priorityForOrigin('pipeline')).toBe('normal');
    expect(priorityForOrigin('agent')).toBe('normal');
  });

  it('couvre toutes les origines connues', () => {
    const origins = [
      'manual',
      'routine',
      'kanban',
      'telegram',
      'discord',
      'slack',
      'pipeline',
      'agent',
      'training',
    ] as const;
    for (const origin of origins) {
      expect(['interactive', 'normal', 'background']).toContain(priorityForOrigin(origin));
    }
  });
});
