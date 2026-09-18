import type { NodeTypes } from '@xyflow/react';
import { ResourceNode } from './ResourceNode';
import { RoomNode } from './RoomNode';

export const nodeTypes = { room: RoomNode, resource: ResourceNode } satisfies NodeTypes;
