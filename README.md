# Constru'Projet

Application web légère pour préparer un projet de rénovation, en 5 étapes :

1. **Existant** : dessiner sa maison niveau par niveau (rez, étages, combles, sous-sol), avec murs porteurs et cloisons, portes, fenêtres, escaliers, sanitaires et toiture. On indique les matériaux en place (carrelage ancien, papier peint, simple vitrage, tuiles…) et leur état (bon, moyen, mauvais). Les cotes de chaque mur s'affichent sur le plan (bouton ↔ pour les masquer), et la peinture ou le revêtement de chaque face de mur apparaît comme une bande de couleur le long du mur. On peut aussi **importer un plan** (image ou PDF), le mettre à l'échelle et le laisser retracer les murs, et ajouter des **points de vue** (photos prises d'un endroit précis) pour reporter sols, murs, portes, fenêtres et meubles au bon endroit.
2. **Projet** : démolir, construire, remplacer des châssis, changer les sols (de toute la pièce ou d'une **zone de sol** seulement : coin cuisine, entrée…) et les murs, ajouter ou retirer des meubles. Le budget se met à jour à chaque action, avec métré.
3. **Visite 3D** (textures photo réalistes : parquet, carrelage, brique, enduit, tuiles…) : vue d'ensemble (avec coupe par niveau et toit amovible), visite avec un personnage réaliste et animé (1,70 m), la caméra toujours placée dans son dos (Z/S pour avancer ou reculer, Q/D pour tourner), pour juger l'échelle, ou promenade à hauteur d'yeux, au niveau de son choix. On ouvre les portes et les fenêtres, on allume avec les interrupteurs, on passe du jour à la nuit ; murs, portes fermées et meubles bloquent le passage, les escaliers mènent à l'étage. Un clic sur un élément permet de le modifier. Un point de vue photo peut être superposé à la maquette pour comparer.
4. **Artisans** : carnet d'artisans et choix d'un artisan par poste.
5. **Résumé** : budget poste par poste (matériaux + fourchette de main d'œuvre), mode détail avec le métré et les tâches de chaque corps de métier, impression PDF.

Dans les deux plans, le **clic droit** ouvre un menu d'actions sur l'élément visé : ajouter une porte ou une fenêtre à l'endroit cliqué sur un mur, couper un mur, pivoter ou dupliquer un meuble, poser un sol sur une partie de pièce, supprimer…

Le choix des produits accepte une description en langage naturel, par exemple « grand canapé pas trop foncé » ou « sol bois clair moins de 40 € ».

## Démarrer

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # tests du moteur (géométrie, opérations, chiffrage, recherche)
npm run build    # version de production dans dist/
```

Le projet est enregistré automatiquement dans le navigateur. Le menu ☰ permet d'exporter ou d'importer un projet en JSON, de repartir d'un plan vide ou de recharger la maison de démonstration.

## Tester avec Docker

Il suffit de Docker (Docker Desktop sur Mac ou Windows). L'image contient un petit serveur nginx qui sert l'application, sans Node.js ni base de données.

**Le plus simple : l'image publiée sur le registre GitHub** (rien à construire) :

```bash
docker run --rm -p 7080:80 ghcr.io/mhinnov/buildproject:mvp-renovation
```

Le workflow `.github/workflows/docker.yml` la publie à chaque push, pour Intel/AMD et ARM (Mac Apple Silicon). Étiquettes : le nom de la branche (`/` remplacé par `-`, ex. `mvp-renovation`), `latest` pour la branche principale, le commit court (`sha-xxxxxxx`) et les tags `v*`. Une fois le MVP fusionné dans `main`, utiliser `ghcr.io/mhinnov/buildproject:latest`.

**Sans cloner le dépôt** (Docker récupère le code sur GitHub et construit l'image, environ 2 minutes la première fois) :

```bash
docker build -t construprojet https://github.com/mhinnov/buildproject.git#mvp-renovation
docker run --rm -p 7080:80 construprojet
```

**Depuis un clone du dépôt**, avec Docker Compose :

```bash
docker compose up --build        # Ctrl+C pour arrêter
```

**Avec une image déjà construite** (fichier `construprojet-image-amd64.tar.gz`, processeurs Intel/AMD ; sur Mac Apple Silicon elle tourne via l'émulation de Docker Desktop) :

```bash
docker load -i construprojet-image-amd64.tar.gz
docker run --rm -p 7080:80 construprojet:latest
```

Ouvrir ensuite http://localhost:7080. Le port 7080 est le port convenu pour ce projet.

Les projets dessinés restent dans le navigateur (stockage local), pas dans le conteneur : on peut arrêter et relancer l'image sans rien perdre. Le menu ☰ permet de les exporter en JSON.

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
- Visite 3D : textures photo réelles (≈ 5 Mo au total, chargées à la demande), teintées à la couleur exacte du produit et mises à l'échelle de ses carreaux ou lames. Le plan 2D garde des motifs dessinés, plus lisibles.
- Rendu « Qualité haute » (occlusion ambiante, antialiasing) prévu pour un ordinateur récent ; « Qualité standard » pour les machines modestes.

## Crédits des ressources 3D

- Personnage : « Michelle » (Adobe Mixamo, repris des exemples three.js), animations « X Bot » (Mixamo) reciblées sur son squelette. Les conditions de Mixamo autorisent l'usage dans un projet, y compris commercial, mais pas la redistribution du fichier seul : à remplacer par un modèle maison avant une diffusion large.
- Éclairage d'ambiance : HDRI « apartment » de Poly Haven (CC0), via `@pmndrs/assets`.
- Textures des matériaux : photos [ambientCG](https://ambientcg.com) (CC0), liste dans `public/textures/CREDITS.md`, préparées par `scripts/build-textures.py`.
- Pas encore d'annuaire automatique d'artisans (phase 3) : le lien « Chercher à proximité » ouvre une recherche Google Maps.
- La règle de TVA à 6 % (logement de plus de 10 ans) est simplifiée et à vérifier au cas par cas.
