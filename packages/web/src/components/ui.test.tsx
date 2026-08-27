/**
 * Tests des comportements d'accessibilité corrigés dans la passe de refonte.
 *
 * Ils ne vérifient pas une apparence, mais trois promesses qui se cassent en
 * silence à la première refactorisation : le libellé associé à son champ, le
 * focus enfermé dans un dialogue, et le retour du focus à la fermeture.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Field, Modal } from './ui';

afterEach(cleanup);

describe('Field', () => {
  it('associe le libellé à son champ', () => {
    render(
      <Field label="Jeton d'accès">
        <input className="input" />
      </Field>,
    );
    /* getByLabelText échoue si le <label> n'est relié à rien : c'est
       exactement le défaut que le composant corrige. */
    expect(screen.getByLabelText("Jeton d'accès")).toBeDefined();
  });

  it("rattache l'indice au champ pour qu'il soit annoncé", () => {
    render(
      <Field label="Modèle" hint="sonnet, opus ou haiku">
        <input className="input" />
      </Field>,
    );
    const field = screen.getByLabelText('Modèle');
    const describedBy = field.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toBe('sonnet, opus ou haiku');
  });

  it('ne réécrit pas un identifiant déjà posé', () => {
    render(
      <Field label="Couleur">
        <input id="couleur-imposee" className="input" />
      </Field>,
    );
    expect(document.getElementById('couleur-imposee')).toBeTruthy();
  });
});

describe('Modal', () => {
  it('se déclare comme dialogue modal et nomme son titre', () => {
    render(
      <Modal title="Nouveau run" onClose={() => {}}>
        <input aria-label="Prompt" />
      </Modal>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const labelledBy = dialog.getAttribute('aria-labelledby');
    expect(document.getElementById(labelledBy!)?.textContent).toBe('Nouveau run');
  });

  it('donne le focus au premier champ, pas au bouton de fermeture', () => {
    render(
      <Modal title="Nouveau run" onClose={() => {}}>
        <input aria-label="Prompt" />
      </Modal>,
    );
    expect(document.activeElement).toBe(screen.getByLabelText('Prompt'));
  });

  it('verrouille le défilement du fond, et le libère à la fermeture', () => {
    const { unmount } = render(
      <Modal title="Nouveau run" onClose={() => {}}>
        <input aria-label="Prompt" />
      </Modal>,
    );
    expect(document.body.style.overflow).toBe('hidden');
    unmount();
    expect(document.body.style.overflow).toBe('');
  });

  it('ferme sur Échap', () => {
    const onClose = vi.fn();
    render(
      <Modal title="Nouveau run" onClose={onClose}>
        <input aria-label="Prompt" />
      </Modal>,
    );
    fireEvent.keyDown(window, { code: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('enferme la tabulation : depuis le dernier élément, on revient au premier', () => {
    render(
      <Modal title="Nouveau run" onClose={() => {}}>
        <input aria-label="Prompt" />
        <button>Lancer</button>
      </Modal>,
    );
    const last = screen.getByText('Lancer');
    last.focus();
    fireEvent.keyDown(document, { code: 'Tab' });
    /* Sans piège, le focus serait sorti du dialogue vers la page derrière. */
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Fermer' }));
  });
});
