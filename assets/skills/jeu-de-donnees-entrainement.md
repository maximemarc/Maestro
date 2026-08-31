---
name: Jeu de données d'entraînement
description: Constituer un corpus de trajectoires exploitable pour du fine-tuning ou du renforcement, à partir des runs de l'instance
---

Tu prépares un jeu de données à partir de trajectoires d'agents. La qualité d'un
corpus se décide avant l'export, pas après.

## Ce qui fait une trajectoire utile

- **Elle appelle des outils.** Une réponse rédigée sans outil n'apprend rien à un
  modèle qu'on entraîne à s'outiller. Filtre là-dessus.
- **Elle aboutit.** Un run interrompu apprend au modèle à abandonner.
- **Son observation est complète.** Un retour d'outil coupé au milieu apprend au
  modèle à s'arrêter au milieu. Vérifie que la capture intégrale est active dans
  les paramètres avant de produire un lot destiné à l'entraînement — sinon les
  retours sont tronqués à 1 500 caractères.
- **Elle est variée.** Vingt échantillons sur le même prompt produisent vingt
  quasi-doublons : le modèle apprend la formulation, pas la compétence.

## Démarche

1. **Cadrer l'objectif.** Quelle compétence le modèle doit-il acquérir ? Formule-la
   en une phrase avant toute autre chose. « Mieux répondre » n'est pas un objectif.
2. **Écrire les gabarits.** Trois à cinq gabarits distincts, avec des variables
   qui font réellement varier la tâche — pas seulement le vocabulaire.
3. **Pondérer les outils** selon la distribution visée. Un corpus où 90 % des
   échantillons lisent et 10 % écrivent produit un modèle prudent ; l'inverse,
   un modèle qui écrit trop vite. C'est un choix, fais-le explicitement.
4. **Lancer un lot d'essai de 5 échantillons.** Lis-les. Toujours. Un lot de mille
   lancé sans avoir relu cinq trajectoires produit mille trajectoires inutiles.
5. **Noter.** Sans score, pas de renforcement possible. Juge automatique pour le
   volume, correction humaine sur les scores aberrants.
6. **Exporter dans le dialecte du modèle cible.** Un corpus au mauvais dialecte
   apprend une syntaxe d'appel d'outil que le modèle n'émettra jamais.

## Pièges

- **Le budget de tokens est un compromis, pas un réglage neutre.** La compression
  sacrifie d'abord la réflexion, puis les observations longues. Vérifie dans
  l'aperçu ce qui a été retiré avant d'écrire le fichier.
- 🔒 **Un export contient les prompts et les observations en clair.** Sur des
  dossiers réels, ce sont des données personnelles. Relis avant de transmettre le
  fichier à un service tiers, et pseudonymise si le corpus quitte l'entreprise.
- **Un score de 1.0 partout est un signal d'alarme**, pas un succès : c'est
  généralement le juge qui a mal répondu, pas l'agent qui a été parfait.

Termine en appelant `maestro_report` avec : objectif visé, nombre d'échantillons
retenus et écartés (avec les motifs), distribution d'outils obtenue, score moyen.
