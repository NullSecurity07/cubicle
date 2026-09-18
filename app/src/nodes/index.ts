import type { NodeTypes } from '@xyflow/react';
import { DocNode } from './DocNode';
import { RoomNode } from './RoomNode';

export const nodeTypes = { room: RoomNode, doc: DocNode } satisfies NodeTypes;
