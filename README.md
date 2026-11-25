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

## Retraçage d'un plan existant

Importez le plan (image, scan ou PDF) dans l'existant : l'application reconnaît seule la façon dont les murs sont dessinés (noirs pleins, encre, gris ou en couleur, hachurés, ou en double trait), leur épaisseur, les portes (par l'arc de débattement) et les fenêtres (traits de vitrage, même un seul trait au cœur du mur), et en déduit l'échelle (largeur des portes intérieures, à défaut épaisseur des façades). « Retracer les murs » dessine le tout ; étalonner sur une cote connue reste possible pour plus de précision. L'IA, si elle est activée, nomme en plus les pièces et ajoute les ouvertures oubliées.

Ce que fait le retraçage, dans l'ordre :

- plusieurs lectures du dessin sont essayées (traits noirs, encre, aplats, double trait à plusieurs largeurs) et la plus cohérente est gardée : celle qui ferme le plus de pièces, avec des murs qui se rejoignent et qui correspondent à du dessin ;
- les murs creux (deux parois et un vide, doublages) sont réunis en un seul mur ;
- les murs sont raccordés entre eux (bouts alignés, angles dessinés en retrait, baies contre un angle) pour que les pièces se ferment ;
- sont écartés : le cadre de la feuille et du cartouche, les cotes, les symboles pleins (repères de pièce), les textes et les pointillés ;
- un étage sous combles garde ses pignons et ses cloisons même si ses pièces, bordées de rampants, ne se ferment pas.

**Tous les plans d'un coup** (« Importer tous les plans (niveaux et coupes) ») : on dépose ensemble les plans de chaque niveau et les coupes, en images ou en PDF de plusieurs pages. Chaque page est classée d'après son nom, son cartouche et son dessin (modifiable), puis :

- chaque plan importé remplace ce qui était dessiné sur son niveau (murs, pièces, mobilier, sols) ;
- sur un PDF, l'échelle est lue dans le cartouche (« 1/50 ») avec le format de la page ; un plan étalonné donne la sienne aux plans de même format ; sinon chaque plan a son estimation (deux feuilles de même format peuvent être à des échelles différentes) ;
- le rez-de-chaussée sert de référence : les autres niveaux sont calés dessus par leurs murs de façade et de pignon, ce qui corrige aussi leur échelle quand elle n'était qu'estimée (un étage dessiné à une autre échelle retrouve la bonne taille) ; les niveaux manquants sont créés ;
- les fenêtres ne sont placées que dans les murs extérieurs ;
- la coupe donne les hauteurs sous plafond, l'épaisseur des planchers et la forme du toit (plat, monopente, deux pans et sa pente) ; avec plusieurs coupes, la première qui donne une hauteur fait foi. Une coupe tournée sur la page est remise droite, et des hauteurs invraisemblables sont écartées ;
- une même page présente dans deux documents (le plan du rez-de-chaussée seul et dans le dossier complet) n'est retenue qu'une fois, et les plans en trop par rapport aux niveaux que montrent les coupes sont écartés (la raison s'affiche, le classement reste modifiable) ;
- les portes de garage (larges baies, de part et d'autre d'un poteau) sont reconnues dans les façades ;
- **combles aménagés** : un dernier niveau sans façade le long des égouts devient un étage sous combles. Les murs bas (jambettes) sont retrouvés sur le plan et ferment les pièces côté extérieur, les fenêtres de toit (Velux) dessinées en pointillé sont posées dans les rampants, les pignons montent jusqu'au toit et, en 3D, murs et plafonds suivent la pente ;
- un plancher (dalle) couvre toute l'emprise du niveau du dessous, sous chaque étage, trémies d'escalier comprises ;
- **jardin** : le plan d'implantation (maison en noir au milieu de sa parcelle) est reconnu ; la maison dessinée est superposée au rez-de-chaussée, ce qui donne l'échelle et l'orientation, et le contour de la parcelle devient le jardin (pelouse et haie en 3D, contour et surface sur le plan du rez-de-chaussée, retirable dans « Ma maison »).

## Avec ou sans IA

Tout fonctionne sans IA : retraçage du plan par analyse d'image, report des éléments d'une photo par géométrie et couleur.
Dans **Menu > Administration**, on peut activer l'option **Avec IA** (Claude, d'Anthropic) avec sa propre clé API : elle lit les cotes et les pièces d'un plan, et reconnaît les éléments d'une photo. La clé reste dans le navigateur et les images partent directement chez Anthropic ; l'usage est facturé sur le compte de la clé. Le module IA n'est téléchargé que s'il est activé.

## Raccourcis de la visite

| Action | Geste |
| --- | --- |
| Avancer / reculer | Z/W, S ou ↑ ↓ ; Maj pour courir |
| Tourner | Q/A, D ou ← → (la souris n'est pas nécessaire) |
| Regarder en haut / en bas (hauteur d'yeux) | R, F ou Page↑ / Page↓ |
| Ouvrir une porte, allumer | touche E à proximité, ou double-clic sur la porte, clic sur l'interrupteur |
| Actions sur un meuble, un mur, une porte | clic droit (au centre de l'écran en vue à hauteur d'yeux) |
| Tourner la caméra (personnage) | glisser ; molette pour rapprocher |

## Points de vue photo

Dans l'existant, on place un point de vue sur le plan et on y joint la photo prise sur place. En projet, ce point de vue est figé : « Voir la photo du projet » affiche la photo réelle avec les modifications appliquées (démolitions, peintures, sols, meubles), avec un curseur avant / après. Les zones que le projet ne change pas restent celles de la photo.

## Catalogues fournisseurs

**Menu > Administration** permet d'importer le catalogue d'une marque au format CSV (Excel) ou JSON ; un modèle CSV est téléchargeable au même endroit. Les produits importés s'ajoutent aux choix de l'application et restent dans le navigateur. IKEA et Quick-Step ne publient pas de catalogue ouvert ni d'API publique : il faut obtenir le fichier produits auprès de la marque ou d'un distributeur partenaire.

Des **connecteurs** permettent aussi de rechercher des produits en ligne et de les ajouter au catalogue, avec votre propre compte :

| Source | Service | Ce qu'il faut |
| --- | --- | --- |
| IKEA | acteur Apify `mynewhome/ikea` (communautaire, non officiel) | jeton API Apify |
| Brico.be | recherche Brico de la place de marché Writ (non affiliée à Brico) | clé API Writ `wt_…` (offre Pro) |
| Diffusion Menuiserie (Quick-Step) | aucun : pas d'API ni d'export, reprise automatique du site non autorisée | demander le fichier produits et l'importer en CSV |

Rien n'est appelé tant que la clé d'un connecteur n'est pas renseignée. Les clés restent dans le navigateur. Les appels passent par le serveur de l'application (`/connecteurs/…` dans `nginx.conf`, et le même relais en `npm run dev`), car ces services ne peuvent pas être appelés directement depuis une page web.

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
- Le retraçage automatique fonctionne sur des plans nets ou scannés (murs pleins, encre, hachurés, double trait) ; l'échelle estimée peut s'écarter de 10 à 20 % (étalonner sur une cote la rend exacte), et un plan photographié de travers ou très annoté demandera des retouches.
- Les points de vue servent à placer et reconnaître les éléments, pas à mesurer les pièces : les cotes viennent du plan ou du relevé.
- Visite 3D : textures photo réelles (≈ 5 Mo au total, chargées à la demande), teintées à la couleur exacte du produit et mises à l'échelle de ses carreaux ou lames. Le plan 2D garde des motifs dessinés, plus lisibles.
- Rendu « Qualité haute » (occlusion ambiante, antialiasing) prévu pour un ordinateur récent ; « Qualité standard » pour les machines modestes.

## Crédits des ressources 3D

- Personnage : « Michelle » (Adobe Mixamo, repris des exemples three.js), animations « X Bot » (Mixamo) reciblées sur son squelette. Les conditions de Mixamo autorisent l'usage dans un projet, y compris commercial, mais pas la redistribution du fichier seul : à remplacer par un modèle maison avant une diffusion large.
- Éclairage d'ambiance : HDRI « apartment » de Poly Haven (CC0), via `@pmndrs/assets`.
- Textures des matériaux : photos [ambientCG](https://ambientcg.com) (CC0), liste dans `public/textures/CREDITS.md`, préparées par `scripts/build-textures.py`.
- Pas encore d'annuaire automatique d'artisans (phase 3) : le lien « Chercher à proximité » ouvre une recherche Google Maps.
- La règle de TVA à 6 % (logement de plus de 10 ans) est simplifiée et à vérifier au cas par cas.
