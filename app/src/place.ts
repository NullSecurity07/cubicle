import type { StageNode } from './stage';

const GAP = 40;

// `start` if it is free; otherwise the nearest free place in widening rings around it.
export function freeSpot(nodes: StageNode[], start: { x: number; y: number }, width: number, height: number) {
  const hits = (x: number, y: number) => nodes.some((node) => {
    const w = node.width ?? node.measured?.width ?? 0;
    const h = node.height ?? node.measured?.height ?? 0;
    return x < node.position.x + w + GAP && x + width + GAP > node.position.x && y < node.position.y + h + GAP && y + height + GAP > node.position.y;
  });
  for (let ring = 0; ring <= 6; ring += 1) {
    for (let row = -ring; row <= ring; row += 1) {
      for (let column = -ring; column <= ring; column += 1) {
        if (Math.max(Math.abs(row), Math.abs(column)) !== ring) continue;
        const x = start.x + column * (width + GAP);
        const y = start.y + row * (height + GAP);
        if (!hits(x, y)) return { x, y };
      }
    }
  }
  return start;
}
