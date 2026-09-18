import type { NodeProps } from '@xyflow/react';
import type { RoomNodeType } from '../stage';
import { Handles } from './Handles';

export function RoomNode({ data }: NodeProps<RoomNodeType>) {
  return (
    <>
      <div className="card">
        <div className="card__title">{data.role}</div>
        <div className="card__body">
          <img src={data.image} alt={`${data.role} room`} draggable={false} />
        </div>
      </div>
      <Handles />
    </>
  );
}
