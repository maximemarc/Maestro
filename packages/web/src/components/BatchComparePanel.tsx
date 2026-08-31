/**
 * Banc de non-régression : comparer deux lots.
 *
 * Modifier le CLAUDE.md d'un agent ou son modèle est sinon un acte de foi. Deux
 * lots bâtis sur les mêmes prompts, exécutés avec deux configurations, et
 * l'écart se lit cas par cas — score, mais aussi coût, parce qu'un agent qui
 * gagne deux centièmes en doublant sa facture n'est pas une amélioration.
 */
import { useState } from 'react';
import { Scales } from '@phosphor-icons/react';
import type { BatchComparison, CaseVerdict, TrainingBatch } from '@maestro/shared';
import { api } from '../lib/api';
import { fmtCost, fmtTokens } from '../lib/format';
import { EmptyState, ErrorText, Field, Spinner } from './ui';

/** Un verdict par cas, avec la tonalité qui le rend lisible d'un coup d'œil. */
const VERDICT_TONE: Record<CaseVerdict, string> = {
  amélioré: 'succeeded',
  dégradé: 'failed',
  stable: 'queued',
  incomparable: 'cancelled',
};

function fmtDelta(delta: number | null): string {
  if (delta === null) return '—';
  return `${delta >= 0 ? '+' : ''}${delta.toFixed(3)}`;
}

export function BatchComparePanel(props: { batches: TrainingBatch[] }) {
  const { batches } = props;
  const [baseline, setBaseline] = useState('');
  const [candidate, setCandidate] = useState('');
  const [result, setResult] = useState<BatchComparison | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await api.compareTrainingBatches(baseline, candidate));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setResult(null);
    } finally {
      setBusy(false);
    }
  };

  if (batches.length < 2) {
    return (
      <EmptyState
        icon={<Scales size={28} />}
        title="Deux lots sont nécessaires"
        hint="Rejoue le même jeu de prompts avant et après ta modification, puis compare les deux lots."
      />
    );
  }

  return (
    <div>
      <div className="card">
        <div className="section-label">Comparer deux lots</div>
        <p className="text-muted">
          Les deux lots doivent poser les mêmes questions : l’appariement se fait sur le prompt, et
          deux lots sans prompt commun sont refusés plutôt que comparés à tort.
        </p>

        <div className="grid cols-2">
          <Field label="Référence" hint="L’état d’avant la modification.">
            <select
              className="select"
              value={baseline}
              onChange={(e) => setBaseline(e.target.value)}
            >
              <option value="">choisir…</option>
              {batches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Candidat" hint="L’état d’après.">
            <select
              className="select"
              value={candidate}
              onChange={(e) => setCandidate(e.target.value)}
            >
              <option value="">choisir…</option>
              {batches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <button
          className="btn primary mt-2"
          onClick={() => void run()}
          disabled={busy || !baseline || !candidate}
        >
          {busy ? <Spinner /> : <Scales />}
          Comparer
        </button>

        {error && <ErrorText>{error}</ErrorText>}
      </div>

      {result && (
        <div className="card mt-4">
          {/* Le verdict d'abord : un banc dont il faut interpréter soi-même les
              chiffres ne sert à rien. */}
          <div className={`card ${result.summary.regressed > 0 ? 'card-off' : 'card-ok'}`}>
            {result.verdict}
          </div>

          {result.comparable && (
            <>
              <div className="row gap-3 mt-3 wrap">
                <span className="stat-chip">
                  Améliorés <b>{result.summary.improved}</b>
                </span>
                <span className="stat-chip alert">
                  Dégradés <b>{result.summary.regressed}</b>
                </span>
                <span className="stat-chip secondary">
                  Stables <b>{result.summary.unchanged}</b>
                </span>
                <span className="stat-chip ctx">
                  Incomparables <b>{result.summary.incomparable}</b>
                </span>
                <span className="stat-chip ctx">
                  Coût <b>{fmtCost(result.summary.costDelta)}</b>
                </span>
                <span
                  className="stat-chip ctx"
                  title="Entrée + sortie, hors tokens de cache : deux exécutions du même prompt peuvent afficher le même volume pour des coûts très différents."
                >
                  Tokens <b>{fmtTokens(result.summary.tokenDelta)}</b>
                </span>
              </div>
              <p className="text-faint text-xs mt-2">
                Le coût est la référence économique. Les tokens comptent l’entrée et la sortie, hors
                cache : un même volume peut correspondre à des factures très différentes selon que
                le cache a été écrit ou relu.
              </p>

              <div className="table-wrap scroll-y mt-3">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Cas</th>
                      <th>Référence</th>
                      <th>Candidat</th>
                      <th>Écart</th>
                      <th>Verdict</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.cases.map((c) => (
                      <tr key={c.prompt}>
                        <td className="cell-clip clamp-2" title={c.prompt}>
                          {c.prompt}
                        </td>
                        <td className="num">{c.baseline?.score?.toFixed(2) ?? '—'}</td>
                        <td className="num">{c.candidate?.score?.toFixed(2) ?? '—'}</td>
                        <td className="num">{fmtDelta(c.scoreDelta)}</td>
                        <td>
                          <span className={`badge ${VERDICT_TONE[c.verdict]}`}>{c.verdict}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
