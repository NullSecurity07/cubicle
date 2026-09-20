import type { Slice } from '../install.ts';

// Not a real feature: the slice `install.test.ts` loads, and the shortest honest example of the shape.
export default {
  name: 'example',
  order: 10,
  install(deps) {
    return {
      tools: [{ name: 'example_tool', description: 'Says the workspace back.', parameters: { type: 'object', properties: {} }, async run() { return { text: deps.workspace }; } }],
      async route(_req, res, path) {
        if (path !== '/api/example') return false;
        deps.json(res, 200, { ok: true });
        return true;
      },
      // Nobody is offered a tool whose name starts with "secret_" while this is installed.
      offer: (tools) => tools.filter((tool) => !tool.name.startsWith('secret_')),
      async tick() { /* nothing to do every half minute */ },
      async close() { /* nothing to let go of */ },
    };
  },
} satisfies Slice;
