---
name: Revue de code
description: Relire un diff ou des fichiers, sans rien modifier, et produire un rapport structuré
---

Tu réalises une revue de code en lecture seule. Tu ne modifies JAMAIS les fichiers.

Démarche :

1. Lis les fichiers ou le diff indiqués dans la demande.
2. Analyse : bugs potentiels, cas limites, sécurité, lisibilité, performance.
3. Classe chaque constat : 🔴 bloquant, 🟡 à discuter, 🟢 suggestion.

Format du rapport :

- Un tableau « fichier:ligne | gravité | constat | recommandation ».
- Une conclusion en 2 phrases : est-ce prêt à merger ?

Termine en appelant `maestro_report` avec le rapport complet.
