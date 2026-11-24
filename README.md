# Constru'Projet

Application web légère pour préparer un projet de rénovation, en 5 étapes :

1. **Existant** : dessiner sa maison (pièces, murs porteurs et cloisons, portes, fenêtres), indiquer sols, revêtements et meubles.
2. **Projet** : démolir, construire, remplacer des châssis, changer les sols et les murs, ajouter ou retirer des meubles. Le budget se met à jour à chaque action, avec métré.
3. **Visite 3D** : vue d'ensemble ou promenade à hauteur d'yeux ; un clic sur un sol, un mur, une fenêtre ou un meuble permet de le modifier.
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

## Tester avec Docker

Il suffit de Docker (Docker Desktop sur Mac ou Windows). L'image contient un petit serveur nginx qui sert l'application, sans Node.js ni base de données.

**Le plus simple : l'image publiée sur le registre GitHub** (rien à construire) :

```bash
docker run --rm -p 8080:80 ghcr.io/mhinnov/buildproject:mvp-renovation
```

Le workflow `.github/workflows/docker.yml` la publie à chaque push, pour Intel/AMD et ARM (Mac Apple Silicon). Étiquettes : le nom de la branche (`/` remplacé par `-`, ex. `mvp-renovation`), `latest` pour la branche principale, le commit court (`sha-xxxxxxx`) et les tags `v*`. Une fois le MVP fusionné dans `main`, utiliser `ghcr.io/mhinnov/buildproject:latest`.

**Sans cloner le dépôt** (Docker récupère le code sur GitHub et construit l'image, environ 2 minutes la première fois) :

```bash
docker build -t construprojet https://github.com/mhinnov/buildproject.git#mvp-renovation
docker run --rm -p 8080:80 construprojet
```

**Depuis un clone du dépôt**, avec Docker Compose :

```bash
docker compose up --build        # Ctrl+C pour arrêter
```

**Avec une image déjà construite** (fichier `construprojet-image-amd64.tar.gz`, processeurs Intel/AMD ; sur Mac Apple Silicon elle tourne via l'émulation de Docker Desktop) :

```bash
docker load -i construprojet-image-amd64.tar.gz
docker run --rm -p 8080:80 construprojet:latest
```

Ouvrir ensuite http://localhost:8080. Si le port 8080 est déjà pris, remplacer `8080:80` par `8090:80` (et ouvrir http://localhost:8090).

Les projets dessinés restent dans le navigateur (stockage local), pas dans le conteneur : on peut arrêter et relancer l'image sans rien perdre. Le menu ☰ permet de les exporter en JSON.

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
- `src/data/` : catalogue et maison de démonstration.
- `src/ui/` : plan 2D (SVG), panneau de propriétés, artisans, résumé.
- `src/three/` : visite 3D (three.js via React Three Fiber), chargée seulement à l'ouverture de l'étape 3.

## Limites connues du MVP

- **Le catalogue et les prix sont fictifs** (produits génériques). Ils seront remplacés par des flux fournisseurs réels.
- Les fourchettes de main d'œuvre sont indicatives et à valider avec des artisans.
- Un seul niveau ; pas encore d'import de plan scanné ni de photos (phase 2).
- Pas encore d'annuaire automatique d'artisans (phase 3) : le lien « Chercher à proximité » ouvre une recherche Google Maps.
- La règle de TVA à 6 % (logement de plus de 10 ans) est simplifiée et à vérifier au cas par cas.
