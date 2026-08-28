---
name: Livrer une branche
description: Passer d'un workspace modifié à une branche propre, relisible, avec un message de commit qui explique le pourquoi
---

Tu as modifié des fichiers dans ton workspace. Il s'agit maintenant d'en faire
quelque chose qu'un humain peut relire et fusionner.

## Avant de committer

1. **Relis ton propre diff en entier.** Pas le résumé de ce que tu crois avoir
   fait : le diff. C'est là qu'on trouve le fichier de débogage oublié, la ligne
   commentée, le `console.log`.
2. **Passe le contrôle qualité du projet.** Sur ce dépôt : `npm run qa`. Un commit
   qui ne compile pas fait perdre plus de temps qu'il n'en gagne.
3. 🔒 **Cherche les secrets.** Une clé, un jeton, une URL avec identifiants, un
   extrait de données réelles. Un secret entré dans l'historique est compromis,
   même retiré au commit suivant.
4. **Vérifie le périmètre.** Un fichier modifié hors du sujet annoncé rend la
   relecture pénible : soit il appartient au changement et le message doit le
   dire, soit il n'y appartient pas et il sort.

## Découper

Un commit = une raison de changer. Si le message a besoin d'un « et », il y a
probablement deux commits. Deux commits de trente lignes se relisent ; un commit
de soixante lignes qui fait deux choses ne se relit pas, il s'approuve.

## Le message

- **Première ligne** : l'effet obtenu, à l'impératif ou au substantif, sous
  70 caractères. Pas « fix bug » : *quel* bug, et qu'est-ce qui marche maintenant.
- **Corps** : le *pourquoi*. Le quoi est dans le diff, il n'a pas besoin d'être
  répété. Ce qui manque au diff, c'est ce qu'on a essayé d'abord, la contrainte
  qui a imposé cette forme, le défaut que ça corrige.
- **Ce qu'on ne met pas** : la liste des fichiers touchés, la reformulation du
  code en français, les remerciements.

Un bon test : quelqu'un qui lit le message dans six mois, en cherchant pourquoi
cette ligne bizarre existe, doit trouver sa réponse.

## Nommer la branche

Suis la convention du dépôt — ici `type/description`, types `feature`, `fix`,
`hotfix`, `chore`, `refactor`, `docs`. Sur un dépôt avec suivi de tickets,
l'identifiant du ticket en fait partie.

## Ce que tu ne fais pas seul

- 🔒 Pas de commit sur `main` ou `develop` sans demande explicite.
- 🔒 Pas de `push --force`, pas de réécriture d'un historique partagé.
- 🔒 Pas de fusion : la revue humaine précède le merge, toujours.

Termine par `maestro_report` : la branche créée, le nombre de commits, et ce qui
reste à faire vérifier par un humain.
