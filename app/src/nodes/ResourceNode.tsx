import type { NodeProps } from '@xyflow/react';
import type { ResourceNodeType } from '../stage';
import { Handles } from './Handles';

export function ResourceNode({ data }: NodeProps<ResourceNodeType>) {
  return (
    <>
      <div className="card">
        <div className="card__title">{data.title}</div>
        <div className="card__body" />
      </div>
      <Handles />
    </>
  );
}
