import { isValidElement } from 'react';
import { describe, expect, it } from 'vitest';
import { broken } from './Rich';

// What the pieces came out as: a string stays a string, a break is the <br> element.
const shape = (parts: ReturnType<typeof broken>) => parts.map((part) => (isValidElement(part) ? `<${String(part.type)}>` : part));

describe('a line break inside a table cell', () => {
  it('becomes a real break, however the model wrote the tag', () => {
    expect(shape(broken('• Faster cycles <br>• Rising complexity'))).toEqual(['• Faster cycles ', '<br>', '• Rising complexity']);
    expect(shape(broken('one<br/>two<br />three<BR>four'))).toEqual(['one', '<br>', 'two', '<br>', 'three', '<br>', 'four']);
  });

  it('leaves every other tag as the letters the founder was shown', () => {
    expect(shape(broken('<b>bold</b> and <img src=x>'))).toEqual(['<b>bold</b> and <img src=x>']);
    expect(shape(broken('nothing to break'))).toEqual(['nothing to break']);
    expect(shape(broken(''))).toEqual(['']);
  });
});
