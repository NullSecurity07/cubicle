import type { NodeTypes } from '@xyflow/react';
import { BrowserNode } from './BrowserNode';
import { DocNode } from './DocNode';
import { ProjectNode } from './ProjectNode';
import { RoomNode } from './RoomNode';

export const nodeTypes = { room: RoomNode, doc: DocNode, browser: BrowserNode, project: ProjectNode } satisfies NodeTypes;
