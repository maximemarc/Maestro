---
name: Audit de dépendances
description: Examiner les dépendances d'un projet — vulnérabilités, abandon, licences, poids — et hiérarchiser ce qui doit vraiment bouger
---

Tu audites les dépendances d'un projet. L'objectif n'est pas une liste
exhaustive : c'est de dire ce qui doit bouger cette semaine, ce qui peut attendre,
et ce qui ne bougera jamais.

## Relever

1. **Vulnérabilités connues** — outil du gestionnaire de paquets (`npm audit`,
   `composer audit`). Note le niveau, et surtout si le chemin est _atteignable_ :
   une faille dans un paquet employé seulement par un outil de build local ne
   présente pas le même risque qu'une faille dans le serveur HTTP.
2. **Abandon** — date du dernier publiement, activité du dépôt, ouverture des
   issues. Un paquet sans commit depuis deux ans n'est pas nécessairement mauvais,
   mais il ne sera pas corrigé.
3. **Licences** — toute licence copyleft fort (GPL, AGPL) sur une dépendance
   d'un produit distribué est un point à remonter, pas à trancher seul.
4. **Poids et redondance** — deux bibliothèques qui font la même chose, une
   dépendance de 2 Mo pour une fonction de dix lignes.

## Hiérarchiser

Classe en trois seaux, et pas plus :

- 🔒 **Maintenant** — vulnérabilité atteignable en production, ou licence
  incompatible. Avec le correctif exact : version cible, et ce qui casse.
- **Prochaine itération** — abandon avec alternative claire, montée de version
  majeure sans urgence.
- **Constat** — noté, aucune action. Le dire évite qu'on le redécouvre.

Une liste de trente points au même niveau ne sera pas traitée. Trois points
hiérarchisés le seront.

## Ce qu'il ne faut pas faire

- **Ne monte pas de version toi-même sans le dire.** Une montée majeure change un
  comportement ; c'est un changement à part, avec ses tests.
- **N'ajoute jamais de dépendance pour résoudre un audit de dépendances.**
- **Ne fais pas confiance au seul score de l'outil.** Un CVE « critique » sur un
  chemin mort est moins urgent qu'un « moyen » sur la façade publique. Le dire.

## Vérifier avant de conclure

Le contrôle n'est vert que si l'outil a réellement tourné. Un audit qui échoue au
lancement — démon absent, registre injoignable — n'est pas un audit sans
vulnérabilité. Reporte la panne, ne conclus pas.

Termine par `maestro_report` : les trois seaux, dans cet ordre, avec pour chaque
entrée du premier seau la version cible et le risque de régression.
