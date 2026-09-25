import type { NodeTypes } from '@xyflow/react';
import { BoardNode } from './BoardNode';
import { BrowserNode } from './BrowserNode';
import { CoderNode } from './CoderNode';
import { DeckNode } from './DeckNode';
import { DocNode } from './DocNode';
import { InterviewNode } from './InterviewNode';
import { LeadsNode } from './LeadsNode';
import { LibraryNode } from './LibraryCard';
import { MetricsNode } from './MetricsNode';
import { ImageGenNode, VideoGenNode, VoiceGenNode } from './MediaCards';
import { RoomNode } from './RoomNode';
import { RunwayNode } from './RunwayNode';
import { ImageNode, LinkNode, NoteNode, SourceNode } from './SmallCards';

export const nodeTypes = { room: RoomNode, doc: DocNode, browser: BrowserNode, project: CoderNode, board: BoardNode, leads: LeadsNode, deck: DeckNode, metrics: MetricsNode, runway: RunwayNode, interview: InterviewNode, note: NoteNode, image: ImageNode, link: LinkNode, source: SourceNode, library: LibraryNode, imagegen: ImageGenNode, voicegen: VoiceGenNode, videogen: VideoGenNode } satisfies NodeTypes;
