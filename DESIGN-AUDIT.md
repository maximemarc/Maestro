# Audit design — Maestro (interface web)

Audit des dix principes de Dieter Rams sur `packages/web` : design system
(`src/styles/global.css`) et pages React. Chaque note s'appuie sur une mesure,
pas sur une impression.

## Mesures

| Mesure                                | Valeur constatée                                                                   |
| ------------------------------------- | ---------------------------------------------------------------------------------- |
| Valeurs d'espacement distinctes (CSS) | **15** — 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18, 20, 48 px                     |
| Tailles de police distinctes          | **14** — 9 en CSS + 10 en dur dans le JSX, dont des demi-pixels (12.5, 13.5, 11.5) |
| Jetons de couleur                     | 19                                                                                 |
| `style={{…}}` dans les pages          | **265** — le système est contourné massivement                                     |
| `:focus-visible`                      | **0 occurrence**, et `outline: none` sur les champs (global.css:216)               |
| `prefers-reduced-motion`              | **0 occurrence**, pour 4 animations permanentes                                    |
| `aria-live` sur les zones d'erreur    | 0                                                                                  |
| Poids JS initial                      | ~390 kB (118 kB gzip)                                                              |

## Notes

| #   | Principe                         | Note | Justification                                                                                                                                                    |
| --- | -------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Innovant                         | 2/3  | Graphe force-directed et radar polaire dans un orchestrateur : rafraîchissement réel d'un genre habituellement tabulaire, et tenu sobrement.                     |
| 2   | Utile                            | 3/3  | La tâche première — lancer et surveiller un run — est atteignable en une action depuis Mission Control ; aucune action leurre.                                   |
| 3   | Esthétique                       | 1/3  | 14 tailles de police et 15 pas d'espacement : il n'y a pas de système visible, mais une accumulation de valeurs ad hoc. 265 styles inline confirment la dérive.  |
| 4   | Compréhensible                   | 2/3  | Libellés en français explicites, mais `Field` produit un `<label>` non associé à son champ, et quelques termes techniques affleurent (« engine », « cliAgent »). |
| 5   | Discret                          | 2/3  | Chrome sombre et calme, le contenu domine ; les pastilles pulsantes attirent l'œil un peu plus que nécessaire.                                                   |
| 6   | Honnête                          | 3/3  | Aucun superlatif marketing, aucun dark pattern ; les avertissements avant import de skill ou de plugin disent exactement le risque encouru.                      |
| 7   | Durable                          | 2/3  | Pas de dégradé à la mode ni de skeuomorphisme ; un marqueur daté : l'emoji tient lieu d'iconographie partout.                                                    |
| 8   | Soigné                           | 2/3  | États vide, chargement, erreur, succès et désactivé présents ; **le focus clavier est absent** — `outline: none` sans remplacement.                              |
| 9   | Économe                          | 1/3  | 390 kB, sous le seuil, mais les animations tournent en permanence sans respecter `prefers-reduced-motion` : coût d'attention et d'énergie non maîtrisé.          |
| 10  | Aussi peu de design que possible | 2/3  | Les éléments gagnent globalement leur place, mais 265 styles inline dupliquent ce que le système devrait porter.                                                 |

**Total : 20/30** — aucun principe à 0.

## Verdict : AFFINER

Les fondations sont saines : la structure sert la tâche (#2 à 3/3) et le discours
est honnête (#6 à 3/3). Ce qui manque n'est pas une refonte mais une
consolidation — le design system existe sur le papier et n'est pas tenu dans les
faits.

### Cinq mouvements, par ordre de levier

1. **#3 Esthétique** — Réduire à une échelle unique : espacement sur base 4
   (4/8/12/16/24/32/48) et six graduations typographiques. Supprimer les
   demi-pixels.
2. **#8 Soigné** — Rétablir un focus clavier visible : anneau `:focus-visible`
   sur tout élément interactif ; ne plus supprimer `outline` sans le remplacer.
3. **#9 Économe** — Conditionner toute animation à `prefers-reduced-motion`,
   canvas compris (graphe, radar).
4. **#3 / #10** — Absorber les styles inline récurrents dans les classes
   utilitaires qui leur manquaient (texte atténué, mono, troncature, zone
   défilante, piles espacées).
5. **#4 Compréhensible** — Associer le `<label>` de `Field` à son champ, et
   annoncer les erreurs via `aria-live`.

Hors périmètre de cette passe : la structure des pages, la navigation, les
parcours — ils tiennent.
