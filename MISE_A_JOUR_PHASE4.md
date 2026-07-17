# Mise à jour (phase 4)

`repository.js` et `app.js` ont été mis à jour pour utiliser la vraie
intégration Wave livrée en phase 4 (dossier `v3-public/supabase/functions/`) :

- `initierPaiementWave()` appelle désormais la fonction Edge
  `wave-initier-paiement` (avant : une ligne en base sans jamais contacter
  Wave) et reçoit un vrai `wave_launch_url`.
- La modale de paiement affiche ce lien comme bouton cliquable — obligatoire
  selon Wave, qui interdit de l'ouvrir en webview ou de le capturer par
  fetch — pendant que la confirmation du webhook est attendue en arrière-plan.

Aucune autre action nécessaire côté livreur : déploie simplement la fonction
Edge Wave (voir `v3-public/README_PUBLIC.md`) et tout se branche automatiquement.
