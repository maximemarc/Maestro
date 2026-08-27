/**
 * Frontière d'erreur de route.
 *
 * Les pages sont chargées à la demande. Un module qui n'arrive pas — coupure
 * réseau, serveur redéployé pendant qu'une session est restée ouverte, chunk
 * expiré — laissait un écran vide sans un mot. Un écran vide se lit comme une
 * panne de l'application entière, alors qu'un rechargement suffit.
 *
 * Elle attrape aussi les erreurs de rendu d'une page : le reste de la coque
 * (navigation, barre d'état) survit, et l'utilisateur peut aller ailleurs.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ArrowClockwise, WarningCircle } from '@phosphor-icons/react';

interface Props {
  children: ReactNode;
  /** Change de valeur => on retente. La route en est un bon porteur. */
  resetKey?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    /* Pas de service de télémétrie ici : la console reste le seul journal, et
       la trace du composant fautif y est indispensable pour diagnostiquer. */
    console.error('[maestro] rendu de page interrompu', error, info.componentStack);
  }

  componentDidUpdate(prev: Props): void {
    /* Changer de page doit effacer l'erreur, sinon la frontière reste bloquée
       sur son message pour toutes les routes suivantes. */
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  private readonly retry = (): void => {
    this.setState({ error: null });
  };

  private readonly reload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="page">
        <div className="card boundary" role="alert">
          <div className="row items-start">
            <span className="text-danger shrink-0">
              <WarningCircle size={22} />
            </span>
            <div className="grow">
              <h2>Cette page n'a pas pu s'afficher</h2>
              <p className="text-muted prose">
                Le reste de Maestro fonctionne : la navigation à gauche reste utilisable. Si
                l'erreur revient après un rechargement, c'est le serveur qu'il faut regarder.
              </p>
              <pre className="scroll-box short break-word mt-3">{error.message}</pre>
              <div className="row gap-2 wrap mt-3">
                <button className="btn primary" onClick={this.retry}>
                  <ArrowClockwise />
                  Réessayer
                </button>
                <button className="btn" onClick={this.reload}>
                  Recharger la page
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }
}
