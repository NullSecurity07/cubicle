import { BaseEdge, getSmoothStepPath, type EdgeProps } from '@xyflow/react';

export function WireEdge({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd }: EdgeProps) {
  const [path] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 10 });
  return (
    <>
      <BaseEdge path={path} markerEnd={markerEnd} />
      <circle className="wire__dot" cx={sourceX} cy={sourceY} r={3.5} />
      <circle className="wire__dot" cx={targetX} cy={targetY} r={3.5} />
    </>
  );
}
