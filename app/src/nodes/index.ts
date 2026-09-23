import type { NodeTypes } from '@xyflow/react';
import { BoardNode } from './BoardNode';
import { BrowserNode } from './BrowserNode';
import { DocNode } from './DocNode';
import { LibraryNode } from './LibraryCard';
import { ImageGenNode, VideoGenNode, VoiceGenNode } from './MediaCards';
import { ProjectNode } from './ProjectNode';
import { RoomNode } from './RoomNode';
import { ImageNode, LinkNode, NoteNode, SourceNode } from './SmallCards';

export const nodeTypes = { room: RoomNode, doc: DocNode, browser: BrowserNode, project: ProjectNode, board: BoardNode, note: NoteNode, image: ImageNode, link: LinkNode, source: SourceNode, library: LibraryNode, imagegen: ImageGenNode, voicegen: VoiceGenNode, videogen: VideoGenNode } satisfies NodeTypes;
