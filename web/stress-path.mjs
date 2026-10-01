// Seeded trajectories make before/after runs repeatable.
export function stressPath(round, seed = 20261001) {
  let state = seed >>> 0;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  const maximum = [20000, 200000, 2000000][round - 1];
  if (!maximum) throw new Error('Stress round must be 1, 2, or 3');
  return Array.from({ length: 12 + round * 4 }, (_, index) => ({
    zoom: index % 4 === 3 ? maximum : 2 ** (Math.log2(400) + random() * Math.log2(maximum / 400)),
    panX: (random() - .5) * (.4 + round * .2),
    panY: (random() - .5) * (.4 + round * .2),
    anchorX: (random() - .5) * 1.4, anchorY: (random() - .5),
  }));
}
