import { describe, expect, it } from 'vitest';
import { demoProject } from '../../data/demoProject';
import { isDoorOpen } from '../doorState';

describe('portes ouvertes par défaut', () => {
  it("ferme la porte d'entrée et ouvre les portes intérieures", () => {
    const b = demoProject().existing;
    const entree = b.openings.find((o) => o.id === 'o-entree');
    const chambre = b.openings.find((o) => o.id === 'o-p-chambre');
    expect(isDoorOpen(b, entree, false)).toBe(false);
    expect(isDoorOpen(b, entree, true)).toBe(true);
    expect(isDoorOpen(b, chambre, false)).toBe(true);
    expect(isDoorOpen(b, chambre, true)).toBe(false);
  });
});
