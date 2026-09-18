import { NodeResizer } from '@xyflow/react';
import type { ReactNode } from 'react';
import { Handles } from './Handles';

// What every card shares: glass, resize grips when selected, four handles.
export function Frame({ selected, minWidth, minHeight, children }: { selected: boolean; minWidth: number; minHeight: number; children: ReactNode }) {
  return (
    <>
      <NodeResizer isVisible={selected} minWidth={minWidth} minHeight={minHeight} lineClassName="grip-line" handleClassName="grip" />
      <div className="card">{children}</div>
      <Handles />
    </>
  );
}
