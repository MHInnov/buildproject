"""
Prépare les textures photo (PBR) de la visite 3D à partir des matériaux ambientCG (CC0, https://ambientcg.com).

Usage : python3 scripts/build-textures.py <dossier des matériaux ambientCG téléchargés en 1K-JPG>
Le dossier source contient un sous-dossier par matériau (ex. WoodFloor051/WoodFloor051_1K-JPG_Color.jpg).
Sorties : public/textures/<clé>/{color,normal,rough}.jpg et src/three/photoTextures.json (couleur et rugosité moyennes).
"""
import glob, json, os, sys
from PIL import Image

SOURCES = {
    'oak-planks': 'WoodFloor051',
    'old-planks': 'WoodFloor042',
    'herringbone': 'WoodFloor052',
    'tiles-large': 'Tiles107',
    'tiles-old': 'Tiles142',
    'terracotta': 'Tiles027',
    'cement': 'Tiles131',
    'subway': 'Tiles009',
    'zellige': 'Tiles023',
    'marble': 'Marble018',
    'brick': 'Bricks097',
    'stone': 'Bricks096',
    'plaster': 'Plaster001',
    'crepi': 'Plaster003',
    'wallpaper': 'Wallpaper001A',
    'paneling': 'Planks008',
    'concrete': 'Concrete016',
    'carpet': 'Carpet012',
    'rooftiles': 'RoofingTiles014A',
    'slate': 'RoofingTiles003',
    'zinc': 'Metal009',
    'grass': 'Grass004',
    'fabric': 'Fabric030',
    'wood': 'Wood022',
}

def srgb_to_linear(c):
    c = c / 255
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

def main(src):
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out = os.path.join(root, 'public', 'textures')
    manifest = {}
    for key, name in SOURCES.items():
        files = {k: glob.glob(os.path.join(src, '**', name, '**', f'*_{k}.jpg'), recursive=True) for k in ('Color', 'NormalGL', 'Roughness')}
        if not all(files.values()):
            sys.exit(f'Matériau introuvable : {name}')
        d = os.path.join(out, key)
        os.makedirs(d, exist_ok=True)
        color = Image.open(files['Color'][0]).convert('RGB')
        w, h = color.size
        k = min(1, 1024 / max(w, h))
        color.resize((round(w * k), round(h * k)), Image.LANCZOS).save(os.path.join(d, 'color.jpg'), quality=80, optimize=True, progressive=True)
        Image.open(files['NormalGL'][0]).convert('RGB').resize((round(w * k / 2), round(h * k / 2)), Image.LANCZOS).save(os.path.join(d, 'normal.jpg'), quality=85, optimize=True)
        rough = Image.open(files['Roughness'][0]).convert('L')
        rough.resize((round(w * k / 4), round(h * k / 4)), Image.LANCZOS).save(os.path.join(d, 'rough.jpg'), quality=85, optimize=True)
        # Moyennes (en linéaire) pour teinter la photo à la couleur exacte du produit
        px = list(color.resize((64, 64)).get_flattened_data())
        avg = [sum(srgb_to_linear(p[i]) for p in px) / len(px) for i in range(3)]
        r = list(rough.resize((64, 64)).get_flattened_data())
        manifest[key] = {'source': name, 'aspect': round(h / w, 4), 'avg': [round(a, 5) for a in avg], 'rough': round(sum(r) / len(r) / 255, 4)}
    with open(os.path.join(root, 'src', 'three', 'photoTextures.json'), 'w') as f:
        json.dump(manifest, f, indent=2)
        f.write('\n')

if __name__ == '__main__':
    main(sys.argv[1])
