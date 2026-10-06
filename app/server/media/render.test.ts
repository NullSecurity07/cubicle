import { describe, expect, it } from 'vitest';
import { renderWords } from './render.ts';

// Journey 13: "rendering · [HyperFrames] render runtime fps [object Object]" in a founder's film log.
describe('what the renderer says, in words', () => {
  it('never passes on an object it printed as [object Object], or the start of its JSON', () => {
    expect(renderWords('[HyperFrames] render runtime fps [object Object]')).toBeNull();
    expect(renderWords('[INFO] [Render:trace] {')).toBeNull();
    expect(renderWords('[INFO] [Render] Pipeline started {\\')).toBeNull();
    expect(renderWords('[initSession:screenshot] GSAP proxy flush complete (12ms)')).toBeNull();
  });

  it('says the steps a founder can follow', () => {
    expect(renderWords('[BrowserManager] Browser launched (Chrome/131.0.0.0, screenshot, gl=--use-gl=angle, headless')).toBe('the renderer is open');
    expect(renderWords('[INFO] Calibration: capturing test frame 2/3... {')).toBeNull();
    expect(renderWords('[INFO] Calibration: capturing test frame 2/3...')).toBe('measuring how fast this machine draws a frame');
    expect(renderWords('[static-dedup] reused 410/600 frame(s) (68%), est. ~9000ms saved (avg 22ms/frame)')).toBe('410 of 600 frames are still and were drawn once');
    expect(renderWords('Rendering frame 120/600')).toBe('frame 120 of 600');
  });
});
