import { Handle, Position } from '@xyflow/react';

// Every handle is a source; the canvas runs in loose connection mode, so any handle connects to any other.
const SIDES = [
  ['l', Position.Left],
  ['r', Position.Right],
  ['t', Position.Top],
  ['b', Position.Bottom],
] as const;

export function Handles() {
  return (
    <>
      {SIDES.map(([id, position]) => (
        <Handle key={id} id={id} type="source" position={position} className="dot" />
      ))}
    </>
  );
}
