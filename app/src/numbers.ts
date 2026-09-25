// Numbers the way a person says them: 940, 12.4k, 1.3M. Every count of tokens in the window is said this one way.
export const compact = (value: number) => (value < 1000 ? String(Math.round(value)) : value < 1_000_000 ? `${(value / 1000).toFixed(value < 10_000 ? 1 : 0).replace(/\.0$/, '')}k` : `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`);
