/**
 * La frontière d'erreur existe parce que les pages sont chargées à la demande :
 * un module qui n'arrive pas laissait un écran vide. Ces tests vérifient les
 * trois promesses qu'on lui demande.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

function Explose({ quand }: { quand: boolean }) {
  if (quand) throw new Error('module introuvable');
  return <p>contenu de la page</p>;
}

beforeEach(() => {
  /* React consigne l'erreur attrapée : c'est voulu, mais on ne veut pas en
     polluer la sortie des tests. */
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe('ErrorBoundary', () => {
  it('laisse passer le contenu quand rien ne casse', () => {
    render(
      <ErrorBoundary>
        <Explose quand={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByText('contenu de la page')).toBeDefined();
  });

  it("affiche un message actionnable et le texte de l'erreur", () => {
    render(
      <ErrorBoundary>
        <Explose quand={true} />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeDefined();
    expect(screen.getByText("Cette page n'a pas pu s'afficher")).toBeDefined();
    expect(screen.getByText('module introuvable')).toBeDefined();
    expect(screen.getByRole('button', { name: /Réessayer/ })).toBeDefined();
  });

  it('retente le rendu quand on clique Réessayer', () => {
    const { rerender } = render(
      <ErrorBoundary>
        <Explose quand={true} />
      </ErrorBoundary>,
    );
    /* La cause a disparu entre-temps (le réseau est revenu) : le nouveau rendu
       doit aboutir, sinon le bouton ne sert à rien. */
    rerender(
      <ErrorBoundary>
        <Explose quand={false} />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Réessayer/ }));
    expect(screen.getByText('contenu de la page')).toBeDefined();
  });

  it('efface son erreur au changement de route', () => {
    const { rerender } = render(
      <ErrorBoundary resetKey="/agents">
        <Explose quand={true} />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeDefined();
    /* Sans cette remise à zéro, la frontière resterait bloquée sur son message
       pour toutes les pages visitées ensuite. */
    rerender(
      <ErrorBoundary resetKey="/runs">
        <Explose quand={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByText('contenu de la page')).toBeDefined();
  });
});
