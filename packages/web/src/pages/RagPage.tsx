/**
 * Page RAG : collections documentaires, ingestion et essai de recherche.
 *
 * Le RAG n'est utile que si l'on peut vérifier ce qu'il retrouve. L'essai de
 * recherche est donc au même niveau que l'ingestion, pas caché : confier une
 * collection à un agent sans avoir vu ce qu'elle rend, c'est lui confier une
 * source dont on ignore la qualité.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  ArrowsClockwise,
  Books,
  CaretDown,
  CaretRight,
  Database,
  FileText,
  FolderOpen,
  Globe,
  MagnifyingGlass,
  GraphIcon,
  Plus,
  Robot,
  Scissors,
  Table,
  Sparkle,
} from '@phosphor-icons/react';
import type {
  RagChunkView,
  RagGraph as RagGraphData,
  RagCollection,
  RagDocument,
  RagEmbeddingStatus,
  RagMaintenanceReport,
  RagSearchResult,
  RagSourceKind,
} from '@maestro/shared';
import RagGraph from '../components/graph/RagGraph';
import { api, type RagCollectionInput, type RagIngestInput } from '../lib/api';
import { useStore } from '../lib/store';
import {
  ConfirmButton,
  EmptyState,
  ErrorText,
  Field,
  LoadingBlock,
  Modal,
  Spinner,
} from '../components/ui';

const SOURCE_LABELS: Record<RagSourceKind, string> = {
  text: 'Texte collé',
  file: 'Fichier',
  directory: 'Dossier',
  url: 'Page web',
  workspace: 'Workspace d’agent',
};

function sourceIcon(kind: RagSourceKind) {
  if (kind === 'text') return <FileText />;
  if (kind === 'file') return <FileText />;
  if (kind === 'directory') return <FolderOpen />;
  if (kind === 'url') return <Globe />;
  return <Robot />;
}

const BLANK_COLLECTION: RagCollectionInput = {
  slug: '',
  name: '',
  description: '',
  chunkSize: 1200,
  chunkOverlap: 150,
};

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} ko`;
  return `${(n / (1024 * 1024)).toFixed(1)} Mo`;
}

export default function RagPage() {
  const collections = useStore((s) => s.ragCollections);
  const notify = useStore((s) => s.notify);

  const [embedding, setEmbedding] = useState<RagEmbeddingStatus | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; form: RagCollectionInput } | null>(
    null,
  );
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    api
      .ragEmbeddingStatus()
      .then(setEmbedding)
      .catch(() => setEmbedding(null));
  }, []);

  const save = async () => {
    if (!editing) return;
    setBusy(true);
    setFormError(null);
    try {
      if (editing.id) {
        await api.updateRagCollection(editing.id, editing.form);
        notify(`« ${editing.form.name} » enregistrée.`);
      } else {
        const created = await api.createRagCollection(editing.form);
        notify(`« ${created.name} » créée.`);
        setOpenId(created.id);
      }
      setEditing(null);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (collection: RagCollection) => {
    setPageError(null);
    try {
      await api.deleteRagCollection(collection.id);
      if (openId === collection.id) setOpenId(null);
      notify(`« ${collection.name} » supprimée.`);
    } catch (err) {
      setPageError(err instanceof Error ? err.message : 'Erreur inconnue');
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <h1>RAG</h1>
        <span className="spacer" />
        <button
          className="btn primary"
          onClick={() => {
            setFormError(null);
            setEditing({ id: null, form: { ...BLANK_COLLECTION } });
          }}
        >
          <Plus />
          Nouvelle collection
        </button>
      </div>
      <p className="page-lede">
        Une collection est un corpus que tes agents peuvent interroger. Tu l'alimentes par un texte
        collé, un fichier, un dossier, une page web ou le workspace d'un agent ; Maestro découpe et
        indexe. La collection devient interrogeable par un agent quand tu l'actives dans sa
        configuration.
      </p>

      {embedding && <EmbeddingBanner status={embedding} />}
      {pageError && <ErrorText>{pageError}</ErrorText>}

      {collections.length === 0 ? (
        <EmptyState
          icon={<Books size={28} />}
          title="Aucune collection"
          hint="Crée une collection, colle-y une procédure, et essaie la recherche : c'est le tour complet en trois gestes."
        >
          <button
            className="btn primary"
            onClick={() => {
              setFormError(null);
              setEditing({ id: null, form: { ...BLANK_COLLECTION } });
            }}
          >
            <Plus />
            Nouvelle collection
          </button>
        </EmptyState>
      ) : (
        <div className="col gap-3">
          {collections.map((collection) => (
            <CollectionCard
              key={collection.id}
              collection={collection}
              open={openId === collection.id}
              embeddingAvailable={embedding?.available ?? false}
              onToggleOpen={() => setOpenId(openId === collection.id ? null : collection.id)}
              onEdit={() => {
                setFormError(null);
                setEditing({
                  id: collection.id,
                  form: {
                    slug: collection.slug,
                    name: collection.name,
                    description: collection.description,
                    chunkSize: collection.chunkSize,
                    chunkOverlap: collection.chunkOverlap,
                  },
                });
              }}
              onRemove={() => void remove(collection)}
            />
          ))}
        </div>
      )}

      {editing && (
        <Modal
          title={editing.id ? 'Modifier la collection' : 'Nouvelle collection'}
          onClose={() => setEditing(null)}
        >
          <div className="grid cols-2">
            <Field label="Nom">
              <input
                className="input"
                value={editing.form.name}
                onChange={(e) =>
                  setEditing({ ...editing, form: { ...editing.form, name: e.target.value } })
                }
                placeholder="Ex. Procédures comptables"
                data-autofocus
              />
            </Field>
            <Field label="Identifiant" hint="Vu par l'agent dans rag_search. Généré si vide.">
              <input
                className="input mono"
                value={editing.form.slug}
                onChange={(e) =>
                  setEditing({ ...editing, form: { ...editing.form, slug: e.target.value } })
                }
                placeholder="procedures-comptables"
              />
            </Field>
          </div>

          <Field label="Description" hint="Ce que contient la collection. L'agent la lit aussi.">
            <input
              className="input"
              value={editing.form.description}
              onChange={(e) =>
                setEditing({ ...editing, form: { ...editing.form, description: e.target.value } })
              }
            />
          </Field>

          <div className="grid cols-2">
            <Field
              label="Taille de découpe"
              hint="En caractères. Plus petit = passages précis mais sans contexte ; plus grand = l'inverse."
            >
              <input
                className="input"
                type="number"
                min={300}
                max={4000}
                value={editing.form.chunkSize}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    form: { ...editing.form, chunkSize: Number(e.target.value) },
                  })
                }
              />
            </Field>
            <Field
              label="Recouvrement"
              hint="Ce que deux morceaux consécutifs partagent, pour ne pas couper une idée en deux."
            >
              <input
                className="input"
                type="number"
                min={0}
                max={Math.floor(editing.form.chunkSize / 2)}
                value={editing.form.chunkOverlap}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    form: { ...editing.form, chunkOverlap: Number(e.target.value) },
                  })
                }
              />
            </Field>
          </div>

          {editing.id && (
            <p className="text-warn text-sm">
              Changer la découpe ne réindexe pas les documents déjà présents : il faut les réingérer
              pour que la nouvelle taille s'applique.
            </p>
          )}

          {formError && <ErrorText>{formError}</ErrorText>}

          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setEditing(null)} disabled={busy}>
              Annuler
            </button>
            <button
              className="btn primary"
              onClick={() => void save()}
              disabled={busy || editing.form.name.trim() === ''}
            >
              {busy && <Spinner />}
              Enregistrer
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* --------------------------------------------------------------------------
 * Bandeau d'état des embeddings
 * ------------------------------------------------------------------------ */

/**
 * Dit franchement quel moteur de recherche est actif.
 *
 * Sans ce bandeau, une recherche purement lexicale passerait pour une recherche
 * sémantique décevante. Nommer le moteur évite de faire porter au RAG un
 * reproche qui appartient à sa configuration.
 */
function EmbeddingBanner({ status }: { status: RagEmbeddingStatus }) {
  if (status.available) {
    return (
      <div className="tile row gap-2 wrap mb-4">
        <span className="text-accent">
          <Sparkle />
        </span>
        <span className="text-sm">
          Recherche <strong>hybride</strong> : termes exacts et sens. Moteur sémantique{' '}
          <code>{status.provider}</code>, modèle <code>{status.model}</code>. Changer de fournisseur
          rend les anciens vecteurs incomparables : ils apparaissent alors comme « périmés » sur la
          collection concernée, et une revectorisation les reprend.
        </span>
      </div>
    );
  }
  return (
    <div className="tile row gap-2 wrap mb-4">
      <span className="text-faint">
        <MagnifyingGlass />
      </span>
      <span className="text-sm text-muted">
        Recherche <strong>lexicale</strong> seule (BM25) : elle trouve les termes exacts, pas les
        reformulations. Pour ajouter le sens, définis <code>{status.envVar}</code> dans
        l'environnement du serveur et redémarre. Aucune clé n'est stockée par Maestro.
      </span>
    </div>
  );
}

/* --------------------------------------------------------------------------
 * Carte d'une collection
 * ------------------------------------------------------------------------ */

function CollectionCard(props: {
  collection: RagCollection;
  open: boolean;
  embeddingAvailable: boolean;
  onToggleOpen: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const { collection } = props;
  const pending = collection.chunkCount - collection.embeddedChunkCount;

  return (
    <div className="card">
      <div className="row wrap">
        <span className="text-accent">
          <Database />
        </span>
        <strong className="text-md">{collection.name}</strong>
        <span className="badge mono">{collection.slug}</span>
        <span className="badge">{collection.documentCount} document(s)</span>
        <span className="badge">{collection.chunkCount} passage(s)</span>
        {props.embeddingAvailable && pending > 0 && (
          <span className="badge warn">{pending} à vectoriser</span>
        )}
        {collection.staleChunkCount > 0 && (
          <span
            className="badge danger"
            title="Ces vecteurs viennent d'un autre modèle : ils ne participent plus au classement sémantique."
          >
            {collection.staleChunkCount} vecteur(s) périmé(s)
          </span>
        )}
        <span className="spacer grow" />
        <button className="btn sm" onClick={props.onToggleOpen} aria-expanded={props.open}>
          {props.open ? 'Replier' : 'Ouvrir'}
        </button>
        <button className="btn ghost sm" onClick={props.onEdit}>
          Réglages
        </button>
        <ConfirmButton
          label="Supprimer"
          title="Supprimer cette collection ?"
          message={`« ${collection.name} », ses ${collection.documentCount} document(s) et son index sont supprimés. Les agents qui l'interrogeaient ne la verront plus.`}
          confirmLabel="Supprimer"
          className="btn danger sm"
          onConfirm={props.onRemove}
        />
      </div>

      {collection.description && (
        <p className="text-muted text-sm mt-2 prose">{collection.description}</p>
      )}

      {props.open && <CollectionPanel collection={collection} />}
    </div>
  );
}

/* --------------------------------------------------------------------------
 * Contenu d'une collection : documents, ingestion, essai
 * ------------------------------------------------------------------------ */

function CollectionPanel({ collection }: { collection: RagCollection }) {
  const notify = useStore((s) => s.notify);
  const agents = useStore((s) => s.agents);

  const [documents, setDocuments] = useState<RagDocument[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ingestOpen, setIngestOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [view, setView] = useState<'documents' | 'graph'>('documents');
  const [busy, setBusy] = useState<'refresh' | 'reindex' | null>(null);
  const [report, setReport] = useState<(RagMaintenanceReport & { label: string }) | null>(null);
  const [openChunksOf, setOpenChunksOf] = useState<string | null>(null);

  /**
   * Rafraîchissement et réindexation.
   *
   * Le compte rendu reste affiché : les documents écartés et ceux retirés parce
   * que leur source a disparu sont l'information utile de l'opération, et une
   * notification qui s'efface les emporterait avec elle.
   */
  const maintain = async (what: 'refresh' | 'reindex') => {
    setBusy(what);
    setError(null);
    setReport(null);
    try {
      const result =
        what === 'refresh'
          ? await api.refreshRagCollection(collection.id)
          : await api.reindexRagCollection(collection.id);
      setReport({
        ...result,
        label: what === 'refresh' ? 'Rafraîchissement terminé' : 'Réindexation terminée',
      });
      notify(
        what === 'refresh'
          ? `${result.documents} document(s) relu(s).`
          : `${result.documents} document(s) redécoupé(s).`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setBusy(null);
    }
  };

  const reload = useCallback(() => {
    api
      .listRagDocuments(collection.id)
      .then(setDocuments)
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : 'Chargement impossible'),
      );
  }, [collection.id]);

  useEffect(reload, [reload, collection.chunkCount, collection.documentCount]);

  const removeDocument = async (doc: RagDocument) => {
    setError(null);
    try {
      await api.deleteRagDocument(collection.id, doc.id);
      notify(`« ${doc.title} » retiré de la collection.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur inconnue');
    }
  };

  return (
    <div className="mt-4">
      <div className="row gap-2 wrap mb-3">
        {/* Deux lectures du même contenu : la table pour agir document par
            document, le graphe pour voir les grappes et les passages isolés. */}
        <div className="row gap-1" role="group" aria-label="Vue de la collection">
          <button
            className={`btn sm${view === 'documents' ? ' primary' : ' ghost'}`}
            onClick={() => setView('documents')}
            aria-pressed={view === 'documents'}
          >
            <Table />
            Documents
          </button>
          <button
            className={`btn sm${view === 'graph' ? ' primary' : ' ghost'}`}
            onClick={() => setView('graph')}
            aria-pressed={view === 'graph'}
          >
            <GraphIcon />
            Graphe
          </button>
        </div>
        <span className="spacer grow" />
        <button className="btn primary sm" onClick={() => setIngestOpen(true)}>
          <Plus />
          Ajouter du contenu
        </button>
        <button className="btn sm" onClick={() => setSearchOpen(true)}>
          <MagnifyingGlass />
          Essayer la recherche
        </button>
        <button
          className="btn sm"
          onClick={() => void maintain('refresh')}
          disabled={busy !== null}
          title="Relit les fichiers, dossiers, pages et workspaces indexés"
        >
          {busy === 'refresh' ? <Spinner /> : <ArrowsClockwise />}
          Rafraîchir
        </button>
        <button
          className="btn sm"
          onClick={() => void maintain('reindex')}
          disabled={busy !== null}
          title="Redécoupe tous les documents avec les réglages actuels"
        >
          {busy === 'reindex' ? <Spinner /> : <Scissors />}
          Réindexer
        </button>
      </div>

      {report && (
        <div className="tile mb-3" role="status">
          <div className="row gap-2 wrap">
            <strong className="text-sm">{report.label}</strong>
            <span className="badge">{report.documents} document(s)</span>
            <span className="badge">{report.chunks} passage(s)</span>
            {report.removed > 0 && (
              <span className="badge warn">{report.removed} retiré(s), source disparue</span>
            )}
          </div>
          {report.skipped.length > 0 && (
            <>
              <div className="section-label mt-2">Écartés ({report.skipped.length})</div>
              <pre className="scroll-box short break-word">
                {report.skipped.map((k) => `${k.source} : ${k.reason}`).join('\n')}
              </pre>
            </>
          )}
        </div>
      )}

      {error && <ErrorText>{error}</ErrorText>}

      {view === 'graph' ? (
        <GraphView collection={collection} />
      ) : documents === null ? (
        <LoadingBlock rows={3} />
      ) : documents.length === 0 ? (
        <p className="text-faint text-sm">
          Collection vide. Ajoute du contenu pour qu'elle serve à quelque chose.
        </p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Document</th>
                <th>Origine</th>
                <th className="num">Passages</th>
                <th className="num">Taille</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {documents.map((doc) => (
                <tr key={doc.id}>
                  <td className="text-strong">{doc.title}</td>
                  <td>
                    <span className="row gap-2">
                      <span className="text-faint">{sourceIcon(doc.sourceKind)}</span>
                      <span className="text-muted text-sm break-all">
                        {doc.source || SOURCE_LABELS[doc.sourceKind]}
                      </span>
                    </span>
                  </td>
                  <td className="num">{doc.chunkCount}</td>
                  <td className="num">{fmtBytes(doc.bytes)}</td>
                  <td>
                    <div className="row gap-2 justify-end">
                      <button
                        className="btn ghost sm"
                        onClick={() => setOpenChunksOf(openChunksOf === doc.id ? null : doc.id)}
                        aria-expanded={openChunksOf === doc.id}
                        title="Voir comment ce document a été découpé"
                      >
                        {openChunksOf === doc.id ? <CaretDown /> : <CaretRight />}
                        Découpage
                      </button>
                      <ConfirmButton
                        label="Retirer"
                        title="Retirer ce document ?"
                        message={`« ${doc.title} » et ses ${doc.chunkCount} passage(s) sortent de l'index.`}
                        confirmLabel="Retirer"
                        onConfirm={() => void removeDocument(doc)}
                      />
                    </div>
                  </td>
                </tr>
              ))}
              {documents.map(
                (doc) =>
                  openChunksOf === doc.id && (
                    <tr key={`${doc.id}-chunks`}>
                      <td colSpan={5}>
                        <ChunkList collectionId={collection.id} documentId={doc.id} />
                      </td>
                    </tr>
                  ),
              )}
            </tbody>
          </table>
        </div>
      )}

      {ingestOpen && (
        <IngestModal
          collection={collection}
          agents={agents.map((a) => ({ id: a.id, name: a.name, emoji: a.emoji }))}
          onClose={() => setIngestOpen(false)}
        />
      )}
      {searchOpen && <SearchModal collection={collection} onClose={() => setSearchOpen(false)} />}
    </div>
  );
}

/* --------------------------------------------------------------------------
 * Vue en graphe
 * ------------------------------------------------------------------------ */

/**
 * Le graphe, son panneau de lecture et la mise en évidence des résultats.
 *
 * La recherche depuis cette vue ne sert pas à lire les passages — la modale
 * d'essai le fait mieux — mais à voir **où** ils tombent : concentrés sur un
 * document, éparpillés, ou dans une grappe qu'on ne soupçonnait pas.
 */
function GraphView({ collection }: { collection: RagCollection }) {
  const [graph, setGraph] = useState<RagGraphData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showSimilar, setShowSimilar] = useState(true);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [hits, setHits] = useState<ReadonlySet<string>>(new Set());
  const [chunkText, setChunkText] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setGraph(null);
    api
      .ragGraph(collection.id)
      .then((data) => {
        if (!cancelled) setGraph(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Chargement impossible');
      });
    return () => {
      cancelled = true;
    };
    /* La topologie suit le nombre de passages : la recharger à chaque
       réindexation ou ingestion, pas plus souvent. */
  }, [collection.id, collection.chunkCount]);

  const selected = graph?.nodes.find((n) => n.id === selectedId) ?? null;

  /* Le contenu d'un passage n'est pas dans le graphe : on va le chercher au
     moment où l'on en sélectionne un, et pas avant. */
  useEffect(() => {
    if (!selected || selected.kind !== 'chunk' || !selected.documentId) {
      setChunkText(null);
      return;
    }
    let cancelled = false;
    api
      .listRagChunks(collection.id, selected.documentId)
      .then((list) => {
        if (cancelled) return;
        const found = list.find((c) => c.chunkIndex === selected.chunkIndex);
        setChunkText(found?.content ?? null);
      })
      .catch(() => {
        if (!cancelled) setChunkText(null);
      });
    return () => {
      cancelled = true;
    };
  }, [collection.id, selected]);

  const runSearch = async () => {
    if (query.trim().length < 2) return;
    setSearching(true);
    try {
      const result = await api.searchRag(collection.id, query.trim(), 10);
      /* Le graphe désigne les passages par identifiant, la recherche par
         document et par numéro : on rapproche les deux par cette clé. */
      const keys = new Set(result.hits.map((h) => `${h.documentId}#${h.chunkIndex}`));
      const matching = (graph?.nodes ?? [])
        .filter((n) => n.kind === 'chunk' && keys.has(`${n.documentId}#${n.chunkIndex ?? -1}`))
        .map((n) => n.id);
      setHits(new Set(matching));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Recherche impossible');
    } finally {
      setSearching(false);
    }
  };

  if (error) return <ErrorText>{error}</ErrorText>;
  if (graph === null) return <LoadingBlock label="Construction du graphe…" rows={4} />;

  const chunkNodes = graph.nodes.filter((n) => n.kind === 'chunk').length;
  const similarLinks = graph.links.filter((l) => l.kind === 'similar').length;

  return (
    <div>
      <div className="row gap-2 wrap mb-3">
        <span className="badge accent">{chunkNodes} passages</span>
        <span className="badge violet">{similarLinks} rapprochements</span>
        {graph.isolatedCount > 0 && (
          <span
            className="badge warn"
            title="Aucun autre passage ne les rejoint : sujet unique dans le corpus, ou découpe à revoir."
          >
            {graph.isolatedCount} isolé(s)
          </span>
        )}
        {graph.truncated && (
          <span className="badge" title={`Collection de ${graph.totalChunks} passages`}>
            vue bornée
          </span>
        )}
        <label className="checkbox-row nowrap">
          <input
            type="checkbox"
            checked={showSimilar}
            onChange={(e) => setShowSimilar(e.target.checked)}
          />
          rapprochements
        </label>
        <span className="spacer grow" />
        <input
          className="input w-lg"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.code === 'Enter') void runSearch();
          }}
          placeholder="Chercher pour situer les passages…"
          aria-label="Chercher et mettre en évidence dans le graphe"
        />
        <button className="btn sm" onClick={() => void runSearch()} disabled={searching}>
          {searching ? <Spinner /> : <MagnifyingGlass />}
          Situer
        </button>
        {hits.size > 0 && (
          <button className="btn ghost sm" onClick={() => setHits(new Set())}>
            Effacer ({hits.size})
          </button>
        )}
      </div>

      <div className="rag-graph-layout">
        <div className="card rag-graph-canvas">
          <RagGraph
            graph={graph}
            selectedId={selectedId}
            highlightIds={hits}
            showSimilar={showSimilar}
            onSelect={setSelectedId}
          />
        </div>

        <div className="card panel-side scroll-y">
          {selected === null ? (
            <EmptyState
              compact
              icon={<GraphIcon size={24} />}
              title="Clique un nœud"
              hint="Un point est un passage, un cercle nommé un document. Les traits fins portent la structure, les traits colorés le rapprochement de vocabulaire. Molette pour zoomer, glisser le fond pour déplacer, double-clic sur le fond pour recadrer."
            />
          ) : (
            <div className="col gap-3">
              <div>
                <div className="section-label">
                  {selected.kind === 'collection'
                    ? 'Collection'
                    : selected.kind === 'document'
                      ? 'Document'
                      : 'Passage'}
                </div>
                <strong className="break-word">{selected.label}</strong>
              </div>

              {selected.kind === 'chunk' && (
                <>
                  <div className="row gap-2 wrap">
                    <span className="badge">{selected.chars} caractères</span>
                    {hits.has(selected.id) && (
                      <span className="badge ok">remonté par la recherche</span>
                    )}
                  </div>
                  {chunkText === null ? (
                    <LoadingBlock rows={3} />
                  ) : (
                    <p className="text-muted text-sm pre-wrap">{chunkText}</p>
                  )}
                </>
              )}

              {selected.kind === 'document' && (
                <p className="text-muted text-sm">
                  {graph.nodes.filter((n) => n.documentId === selected.id).length} passage(s) dans
                  ce document.
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------
 * Inspection du découpage
 * ------------------------------------------------------------------------ */

/**
 * Montre comment un document a été découpé.
 *
 * C'est le premier outil de diagnostic d'un RAG : quand une recherche rend de
 * mauvais passages, la question est presque toujours « où la coupure est-elle
 * tombée ». Le compteur de passages seul ne répond jamais à ça.
 */
function ChunkList(props: { collectionId: string; documentId: string }) {
  const [chunks, setChunks] = useState<RagChunkView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listRagChunks(props.collectionId, props.documentId)
      .then((list) => {
        if (!cancelled) setChunks(list);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Lecture impossible');
      });
    return () => {
      cancelled = true;
    };
  }, [props.collectionId, props.documentId]);

  if (error) return <ErrorText>{error}</ErrorText>;
  if (chunks === null) return <LoadingBlock rows={2} />;
  if (chunks.length === 0) return <p className="text-faint text-sm">Aucun passage indexé.</p>;

  return (
    <div className="col gap-2">
      {chunks.map((chunk) => (
        <div key={chunk.chunkIndex} className="tile">
          <div className="row gap-2 wrap">
            <span className="badge">passage {chunk.chunkIndex + 1}</span>
            <span className="text-faint text-xs num">{chunk.chars} caractères</span>
            {chunk.embedded ? (
              <span className="badge ok">vectorisé</span>
            ) : (
              <span className="badge">lexical seul</span>
            )}
          </div>
          <p className="text-muted text-sm mt-2 pre-wrap">{chunk.content}</p>
        </div>
      ))}
    </div>
  );
}

/* --------------------------------------------------------------------------
 * Ingestion
 * ------------------------------------------------------------------------ */

function IngestModal(props: {
  collection: RagCollection;
  agents: Array<{ id: string; name: string; emoji: string }>;
  onClose: () => void;
}) {
  const notify = useStore((s) => s.notify);
  const [kind, setKind] = useState<RagSourceKind>('text');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<Array<{ source: string; reason: string }>>([]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    setSkipped([]);
    try {
      const body: RagIngestInput = {
        sourceKind: kind,
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(kind === 'text' ? { content } : { source: source.trim() }),
      };
      const report = await api.ingestRagDocument(props.collection.id, body);
      notify(`${report.documents.length} document(s), ${report.chunks} passage(s) indexés.`);
      if (report.skipped.length > 0) {
        /* On ne ferme pas : les écarts sont l'information la plus utile de
           l'opération, et ils disparaîtraient avec la modale. */
        setSkipped(report.skipped);
      } else {
        props.onClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Ajouter du contenu à « ${props.collection.name} »`} onClose={props.onClose}>
      <Field label="Origine">
        <select
          className="select"
          value={kind}
          onChange={(e) => setKind(e.target.value as RagSourceKind)}
        >
          <option value="text">Texte collé</option>
          <option value="file">Fichier sur la machine</option>
          <option value="directory">Dossier sur la machine</option>
          <option value="url">Page web</option>
          <option value="workspace">Workspace d'un agent</option>
        </select>
      </Field>

      {kind === 'text' && (
        <>
          <Field label="Titre">
            <input
              className="input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Ex. Procédure de clôture"
              data-autofocus
            />
          </Field>
          <Field label="Contenu">
            <textarea
              className="textarea"
              rows={12}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Colle ici la procédure, la note, le compte rendu…"
            />
          </Field>
        </>
      )}

      {(kind === 'file' || kind === 'directory') && (
        <Field
          label={kind === 'file' ? 'Chemin du fichier' : 'Chemin du dossier'}
          hint="Chemin absolu sur la machine qui exécute Maestro. Les fichiers binaires et les répertoires techniques sont écartés."
        >
          <input
            className="input mono"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="/home/utilisateur/docs"
            data-autofocus
          />
        </Field>
      )}

      {kind === 'url' && (
        <Field label="URL" hint="La page est téléchargée et son texte extrait, sans les balises.">
          <input
            className="input mono"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="https://exemple.fr/documentation"
            data-autofocus
          />
        </Field>
      )}

      {kind === 'workspace' && (
        <Field
          label="Agent"
          hint="Indexe le répertoire de travail de l'agent : il pourra chercher dans ses propres productions."
        >
          <select className="select" value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">Choisir un agent</option>
            {props.agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.emoji} {agent.name}
              </option>
            ))}
          </select>
        </Field>
      )}

      {error && <ErrorText>{error}</ErrorText>}

      {skipped.length > 0 && (
        <div className="mt-3">
          <div className="section-label">Écartés ({skipped.length})</div>
          <pre className="scroll-box short break-word">
            {skipped.map((s) => `${s.source} : ${s.reason}`).join('\n')}
          </pre>
        </div>
      )}

      <div className="modal-actions">
        <button className="btn ghost" onClick={props.onClose}>
          {skipped.length > 0 ? 'Fermer' : 'Annuler'}
        </button>
        <button
          className="btn primary"
          onClick={() => void submit()}
          disabled={busy || (kind === 'text' ? content.trim() === '' : source.trim() === '')}
        >
          {busy && <Spinner />}
          Indexer
        </button>
      </div>
    </Modal>
  );
}

/* --------------------------------------------------------------------------
 * Essai de recherche
 * ------------------------------------------------------------------------ */

function SearchModal(props: { collection: RagCollection; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [topK, setTopK] = useState(5);
  const [result, setResult] = useState<RagSearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (query.trim().length < 2) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await api.searchRag(props.collection.id, query.trim(), topK));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Chercher dans « ${props.collection.name} »`} onClose={props.onClose} wide>
      <p className="text-muted text-sm prose">
        C'est exactement ce que verra un agent qui appelle <code>rag_search</code> sur cette
        collection.
      </p>

      <div className="row gap-2 wrap items-start">
        <Field label="Question ou mots-clés">
          <input
            className="input w-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.code === 'Enter') void run();
            }}
            placeholder="rapprochement bancaire avant déclaration de TVA"
            data-autofocus
          />
        </Field>
        <Field label="Passages">
          <input
            className="input w-sm"
            type="number"
            min={1}
            max={20}
            value={topK}
            onChange={(e) => setTopK(Number(e.target.value))}
          />
        </Field>
      </div>

      <button className="btn primary" onClick={() => void run()} disabled={busy}>
        {busy ? <Spinner /> : <MagnifyingGlass />}
        Chercher
      </button>

      {error && <ErrorText>{error}</ErrorText>}

      {result && (
        <div className="mt-4">
          <div className="row gap-2 wrap mb-3">
            <span className="badge accent">{result.hits.length} passage(s)</span>
            <span className={`badge ${result.semanticUsed ? 'ok' : ''}`}>
              {result.semanticUsed ? 'lexical + sémantique' : 'lexical seul'}
            </span>
            <span className="text-faint text-xs num">{result.durationMs} ms</span>
          </div>

          {result.hits.length === 0 ? (
            <p className="text-faint text-sm">
              Aucun passage. Reformule, ou vérifie que la collection contient bien ce sujet.
            </p>
          ) : (
            <div className="col gap-3">
              {result.hits.map((hit, index) => (
                <div key={`${hit.documentId}-${hit.chunkIndex}`} className="tile">
                  <div className="row gap-2 wrap">
                    <span className="badge">{index + 1}</span>
                    <strong className="text-sm">{hit.documentTitle}</strong>
                    <span className="text-faint text-xs">passage {hit.chunkIndex + 1}</span>
                    <span className="spacer grow" />
                    {hit.matchedBy.map((engine) => (
                      <span key={engine} className="badge violet">
                        {engine === 'lexical' ? 'lexical' : 'sémantique'}
                      </span>
                    ))}
                    <span className="text-faint text-xs num">{hit.score}</span>
                  </div>
                  <p className="text-muted text-sm mt-2 pre-wrap">{hit.content}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="modal-actions">
        <button className="btn ghost" onClick={props.onClose}>
          Fermer
        </button>
      </div>
    </Modal>
  );
}
