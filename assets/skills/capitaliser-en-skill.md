---
name: Capitaliser en skill
description: Transformer une solution non triviale qu'on vient de trouver en skill réutilisable, au bon moment et sous la bonne forme
---

Tu viens de résoudre quelque chose de non trivial. La question est de savoir si
cela mérite une skill, et si oui, quoi y mettre.

## Quand capitaliser

Écris une skill quand **les trois** conditions sont réunies :

1. La démarche a demandé plus qu'une lecture de documentation — tâtonnement,
   piège contourné, ordre d'opérations non évident.
2. Elle se reproduira. Un problème strictement propre à un fichier n'est pas une
   compétence, c'est un fait : `maestro_memory_save` suffit.
3. Elle est transmissible sans le contexte de la tâche courante.

Sinon, ne fais rien. Un registre de skills gonflé de notes circonstancielles est
pire qu'un registre vide : il dilue les vraies, et on cesse de les lire.

## Mémoire ou skill

| Ce que tu retiens                                              | Où      |
| -------------------------------------------------------------- | ------- |
| Un fait sur l'environnement (« la base est sur le port 5433 ») | mémoire |
| Une préférence de l'utilisateur                                | mémoire |
| Une méthode, un ordre d'opérations, un piège récurrent         | skill   |
| Une correspondance de vocabulaire métier                       | skill   |

## Ce qu'une bonne skill contient

- **Une description qui décide du déclenchement.** C'est le champ le plus
  important : il est lu pour savoir s'il faut charger la skill. « Aide sur les
  bases de données » ne déclenche rien d'utile ; « Diagnostiquer un verrou
  Postgres qui bloque une migration » se déclenche au bon moment.
- **Le pourquoi, pas seulement le quoi.** « Passer `--no-verify` » est inutile
  sans « parce que le hook relance la suite complète et double le temps ».
- **Les pièges d'abord.** Ce qu'on relit une skill pour retrouver, ce n'est pas la
  procédure heureuse, c'est le détail qui a coûté une heure.
- **Un exemple concret**, même court.

## Ce qu'elle ne contient jamais

- 🔒 Aucun secret, jeton, clé ou mot de passe.
- 🔒 Aucune donnée personnelle : ni nom, ni email, ni SIRET, ni montant nominatif.
  Anonymise les exemples (`client A`, `user@example.com`).
- Aucun chemin absolu propre à une machine, sauf s'il est structurel.

## Geste

Appelle `maestro_skill_save` avec un nom court, une description de déclenchement,
et un corps markdown. La skill est enregistrée pour toi seul et disponible dès ton
prochain run ; sa promotion en skill globale, partagée par tous les agents, reste
une décision humaine.
