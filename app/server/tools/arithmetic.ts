// Code that only works numbers out: short, imports nothing, and names nothing that reaches files, the network, the
// process, the environment or the founder's tools. Division for a runway is not worth a "Run this code?" card; such
// code runs in the sandbox at once, and anything else still waits for the founder's yes.
const MAX_LINES = 40;
// Checked over the whole text, strings included, so a name spelt inside quotes is turned down too.
const SHARED = ['import', 'open', 'eval', 'exec', 'compile', 'files', 'tools', 'env', 'environ', 'fs', 'os', 'sys', 'subprocess', 'socket', 'child_process', 'process', 'shutil', 'pathlib', 'pyodide'];
const WORDS: Record<string, string[]> = {
  python: [...SHARED, 'getattr', 'setattr', 'delattr', 'globals', 'locals', 'vars', 'input', 'breakpoint', 'urllib', 'requests', 'http'],
  javascript: [...SHARED, 'require', 'fetch', 'Function', 'globalThis', 'window', 'self', 'Deno', 'Bun', 'XMLHttpRequest', 'WebSocket', 'constructor', 'prototype', 'setTimeout', 'setInterval'],
};
const DUNDER = /__\w*__|__proto__/;

export function plainArithmetic(language: string, code: string): boolean {
  const words = WORDS[language];
  if (!words || !code.trim()) return false;
  if (code.trim().split('\n').length > MAX_LINES) return false;
  if (DUNDER.test(code)) return false;
  return !new RegExp(`(?<![\\w$])(?:${words.join('|')})(?![\\w$])`).test(code);
}
