# Constru'Projet

Application web légère pour préparer un projet de rénovation, en 5 étapes :

1. **Existant** : dessiner sa maison niveau par niveau (rez, étages, combles, sous-sol), avec murs porteurs et cloisons, portes, fenêtres, escaliers, sanitaires et toiture. On indique les matériaux en place (carrelage ancien, papier peint, simple vitrage, tuiles…) et leur état (bon, moyen, mauvais). On peut aussi **importer un plan** (image ou PDF), le mettre à l'échelle et le laisser retracer les murs, et ajouter des **points de vue** (photos prises d'un endroit précis) pour reporter sols, murs, portes, fenêtres et meubles au bon endroit.
2. **Projet** : démolir, construire, remplacer des châssis, changer les sols et les murs, ajouter ou retirer des meubles. Le budget se met à jour à chaque action, avec métré.
3. **Visite 3D** : vue d'ensemble (avec coupe par niveau et toit amovible), visite avec un personnage de 1,75 m suivi de dos pour juger l'échelle, ou promenade à hauteur d'yeux. On ouvre les portes et les fenêtres, on allume avec les interrupteurs, on passe du jour à la nuit ; murs, portes fermées et meubles bloquent le passage, les escaliers mènent à l'étage. Un clic sur un élément permet de le modifier. Un point de vue photo peut être superposé à la maquette pour comparer.
4. **Artisans** : carnet d'artisans et choix d'un artisan par poste.
5. **Résumé** : budget poste par poste (matériaux + fourchette de main d'œuvre), mode détail avec le métré et les tâches de chaque corps de métier, impression PDF.

Le choix des produits accepte une description en langage naturel, par exemple « grand canapé pas trop foncé » ou « sol bois clair moins de 40 € ».

## Démarrer

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # tests du moteur (géométrie, opérations, chiffrage, recherche)
npm run build    # version de production dans dist/
```

Le projet est enregistré automatiquement dans le navigateur. Le menu ☰ permet d'exporter ou d'importer un projet en JSON, de repartir d'un plan vide ou de recharger la maison de démonstration.

## Image Docker

À chaque push, GitHub Actions construit une image Docker (nginx qui sert l'application) et la publie sur le registre GitHub :

```bash
docker run --rm -p 8080:80 ghcr.io/mhinnov/buildproject:latest   # puis http://localhost:8080
```

Étiquettes publiées : `latest` (branche principale), le nom de la branche (ex. `mvp-renovation`), le commit court (`sha-xxxxxxx`) et les tags `v*`.

## Avec ou sans IA

Tout fonctionne sans IA : retraçage du plan par analyse d'image, report des éléments d'une photo par géométrie et couleur.
Dans **Menu > Administration**, on peut activer l'option **Avec IA** (Claude, d'Anthropic) avec sa propre clé API : elle lit les cotes et les pièces d'un plan, et reconnaît les éléments d'une photo. La clé reste dans le navigateur et les images partent directement chez Anthropic ; l'usage est facturé sur le compte de la clé. Le module IA n'est téléchargé que s'il est activé.

## Raccourcis de la visite

| Action | Geste |
| --- | --- |
| Marcher | Z/W, Q/A, S, D ou flèches ; Maj pour courir |
| Ouvrir une porte, allumer | touche E à proximité, ou double-clic sur la porte, clic sur l'interrupteur |
| Tourner la caméra (personnage) | glisser ; molette pour rapprocher |

## Raccourcis du plan

| Action | Geste |
| --- | --- |
| Déplacer le plan | glisser dans le vide, ou bouton du milieu |
| Zoomer | molette, ou boutons + / − |
| Tracer des murs | outil Mur, clic point par point, double-clic ou Échap pour finir, Maj pour un angle libre |
| Tracer une pièce | outil Pièce, glisser un rectangle |
| Supprimer / démolir | touche Suppr sur l'élément sélectionné |
| Pivoter un meuble | touche R |
| Annuler / rétablir | Ctrl+Z / Ctrl+Y |

## Architecture

Tout tourne dans le navigateur (« local-first ») : pas de serveur nécessaire pour ce MVP.

- `src/model/` : le cœur, sans interface et testé.
  - `types.ts` : modèle du bâtiment (murs, ouvertures, pièces, meubles) et opérations du projet.
  - `geometry.ts` : détection automatique des pièces à partir des murs, jonctions en T, aimantation.
  - `operations.ts` : le projet = l'existant + une liste d'opérations ; `applyOperations` calcule le bâtiment projeté.
  - `estimate.ts` : métré et chiffrage par poste (paquets arrondis avec chute, pots de peinture, fourchettes de main d'œuvre, TVA 6 % ou 21 %).
  - `search.ts` : recherche en langage naturel dans le catalogue (couleur, taille, budget, mots-clés).
  - `levels.ts`, `roof.ts` : niveaux, migration des anciens projets, géométrie et surfaces de toiture.
  - `vectorize.ts` : retraçage d'un plan importé (seuillage, épaisseur des murs, portes et fenêtres).
- `src/data/` : catalogue et maison de démonstration.
- `src/ui/` : plan 2D (SVG), panneau de propriétés, artisans, résumé.
- `src/three/` : visite 3D (three.js via React Three Fiber), chargée seulement à l'ouverture de l'étape 3 ; `physics.ts` gère sols, escaliers et collisions.
- `src/textures/` : textures procédurales (parquet, carrelage, brique, tuiles…).
- `src/ai.ts`, `src/settings.ts` : option IA, désactivée par défaut.

## Limites connues du MVP

- **Le catalogue et les prix sont fictifs** (produits génériques). Ils seront remplacés par des flux fournisseurs réels.
- Les fourchettes de main d'œuvre sont indicatives et à valider avec des artisans.
- Le retraçage automatique fonctionne bien sur des plans nets (murs pleins ou hachurés foncés) ; un plan photographié de travers ou très annoté demandera des retouches.
- Les points de vue servent à placer et reconnaître les éléments, pas à mesurer les pièces : les cotes viennent du plan ou du relevé.
- Textures procédurales (générées dans le navigateur, sans images à télécharger) pour garder l'application légère.
- Pas encore d'annuaire automatique d'artisans (phase 3) : le lien « Chercher à proximité » ouvre une recherche Google Maps.
- La règle de TVA à 6 % (logement de plus de 10 ans) est simplifiée et à vérifier au cas par cas.
