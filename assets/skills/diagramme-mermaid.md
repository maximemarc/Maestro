---
name: Diagramme Mermaid
description: Produire un diagramme Mermaid lisible — flux, séquence, entités, état — à partir d'un code ou d'un processus décrit
---

Tu produis un diagramme Mermaid. Un diagramme sert à comprendre plus vite qu'en
lisant le texte : s'il demande plus d'effort que le paragraphe qu'il remplace, il
a échoué.

## Choisir le bon type

| Ce que tu montres                          | Type                           |
| ------------------------------------------ | ------------------------------ |
| Un enchaînement de décisions               | `flowchart TD`                 |
| Un dialogue entre composants dans le temps | `sequenceDiagram`              |
| Un modèle de données                       | `erDiagram`                    |
| Les états d'un objet et ses transitions    | `stateDiagram-v2`              |
| Un découpage en couches ou en modules      | `flowchart LR` avec `subgraph` |

Un diagramme de séquence pour montrer une structure, ou un flowchart pour montrer
une chronologie, sont les deux erreurs les plus fréquentes.

## Règles de lisibilité

- **Sept nœuds environ, pas trente.** Au-delà, découpe en plusieurs diagrammes
  reliés par un nom commun. Un diagramme exhaustif ne se lit pas.
- **Nomme les arêtes** quand la relation n'est pas évidente : `A -->|si absent| B`.
- **Un sens unique.** Une flèche qui remonte doit signifier quelque chose (retour,
  erreur, reprise), jamais un simple manque de place.
- **Pas de couleur décorative.** Une couleur ne sert qu'à distinguer une nature
  (par ex. l'externe de l'interne), et il en faut alors au plus trois.
- **Textes courts.** Une phrase dans un nœud est un aveu que le nœud en cache deux.

## Pièges Mermaid

- Les caractères `(`, `)`, `[`, `]` et `:` dans un libellé cassent l'analyse :
  entoure le texte de guillemets — `A["Lecture (partielle)"]`.
- Les accents passent, les retours à la ligne se notent `<br/>`.
- `graph` est l'ancien mot-clé, `flowchart` le mot-clé courant : préfère le second.
- Un `subgraph` sans identifiant explicite reçoit un nom engendré, illisible dans
  les messages d'erreur : `subgraph infra["Infrastructure"]`.

## Vérification

Avant de rendre le diagramme, relis-le et réponds à une question : **une personne
qui ne connaît pas le sujet saurait-elle dire par où commence le processus ?** Si
non, ajoute un nœud de départ nommé.

Rends le bloc Mermaid, puis deux lignes de légende en prose sur ce que le lecteur
doit en retenir.
