import { describe, expect, it } from 'vitest';
import { matchesKey, roomNamesFromWords, type OcrWord } from '../roomText';

const word = (text: string, conf: number, x: number, line: number): OcrWord => ({ text, conf, x0: x, y0: 100, x1: x + 50, y1: 120, line });

describe('noms des pièces lus par OCR', () => {
  it('tolère les fautes de lecture courantes', () => {
    expect(matchesKey('coisine', 'cuisine')).toBe(true);
    expect(matchesKey('hambre', 'chambre')).toBe(true);
    expect(matchesKey('deuche', 'douche')).toBe(true);
    expect(matchesKey('cloche', 'douche')).toBe(false);
    expect(matchesKey('hal', 'hall')).toBe(false);
  });

  it('lit les noms composés, les numéros sûrs et recolle un mot coupé', () => {
    const r = roomNamesFromWords(
      [
        word('Salle', 96, 0, 1),
        word('à', 93, 60, 1),
        word('manger', 94, 80, 1),
        word('Chambre', 89, 400, 2),
        word('5', 89, 460, 2),
        word('Chambre', 74, 800, 3),
        word('2', 29, 860, 3),
        word('Hall', 79, 1200, 4),
        word('de', 96, 1260, 4),
        word('Noit', 82, 1290, 4),
        word('Gard', 84, 1600, 5),
        word('ge', 91, 1650, 5),
        word('poutrelle', 90, 2000, 6),
      ],
      60,
    ).map((x) => x.name);
    expect(r.sort()).toEqual(['Chambre', 'Chambre 5', 'Garage', 'Hall de nuit', 'Salle à manger']);
  });

  it("ne garde qu'une lecture d'un même nom au même endroit", () => {
    const r = roomNamesFromWords([word('Cuisine', 86, 0, 1), word('Cuisine', 70, 10, 2), word('Cuisine', 90, 500, 3)], 60);
    expect(r).toHaveLength(2);
  });
});

describe('notes techniques', () => {
  it("« S. de bain étage » n'est pas une pièce", () => {
    expect(roomNamesFromWords([word('de', 89, 0, 1), word('bain', 82, 30, 1), word('ctage', 60, 80, 1)], 60)).toEqual([]);
  });
});
