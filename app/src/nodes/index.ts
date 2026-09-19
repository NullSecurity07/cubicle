import type { NodeTypes } from '@xyflow/react';
import { BoardNode } from './BoardNode';
import { BrowserNode } from './BrowserNode';
import { DocNode } from './DocNode';
import { ProjectNode } from './ProjectNode';
import { RoomNode } from './RoomNode';
import { ImageNode, LinkNode, NoteNode } from './SmallCards';

export const nodeTypes = { room: RoomNode, doc: DocNode, browser: BrowserNode, project: ProjectNode, board: BoardNode, note: NoteNode, image: ImageNode, link: LinkNode } satisfies NodeTypes;
