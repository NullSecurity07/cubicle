import type { NodeProps } from '@xyflow/react';
import type { RoomNodeType } from '../stage';
import { Handles } from './Handles';
import { Person } from './Person';

export function RoomNode({ data }: NodeProps<RoomNodeType>) {
  return (
    <>
      <div className="card">
        <div className="card__title">{data.role}</div>
        <div className="card__body card__body--room">
          <Person accent={data.accent} />
        </div>
      </div>
      <Handles />
    </>
  );
}
