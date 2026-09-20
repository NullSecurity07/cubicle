import type { Slice } from '../install.ts';

// Last by name, first by order: proof that `order` wins over the file name.
export default { name: 'zebra', order: 1, install: () => ({}) } satisfies Slice;
