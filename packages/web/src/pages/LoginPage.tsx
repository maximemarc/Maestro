import { useState, type FormEvent } from 'react';
import { Faders } from '@phosphor-icons/react';
import { setToken } from '../lib/api';
import { ErrorText, Field, Spinner } from '../components/ui';

export default function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!value.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/overview', {
        headers: { authorization: `Bearer ${value.trim()}` },
      });
      if (!res.ok) {
        setError('Jeton refusé. Vérifie la valeur affichée au démarrage du serveur.');
        return;
      }
      setToken(value.trim());
      onLogin();
    } catch {
      setError('Serveur injoignable.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center login-viewport">
      <form onSubmit={submit} className="card w-login">
        <div className="text-center mb-4">
          <div className="row justify-center text-accent">
            <Faders size={32} />
          </div>
          <h1 className="mt-2">Maestro</h1>
          <p className="text-muted text-sm">Poste de commandement pour agents Claude Code</p>
        </div>

        <Field
          label="Jeton d'accès"
          hint="Défini par MAESTRO_TOKEN, ou généré dans <dataDir>/token."
        >
          <input
            className={`input${error ? ' invalid' : ''}`}
            type="password"
            /* La page ne contient que ce champ : donner le focus n'enlève
               rien à personne, et évite un clic à chaque démarrage. */
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            autoComplete="current-password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Jeton affiché au démarrage du serveur"
          />
        </Field>

        {error && <ErrorText>{error}</ErrorText>}

        <button className="btn primary block mt-3" disabled={busy || !value.trim()}>
          {busy && <Spinner />}
          {busy ? 'Vérification…' : 'Entrer'}
        </button>
      </form>
    </div>
  );
}
