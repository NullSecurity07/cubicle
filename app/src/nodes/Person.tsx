import { useId } from 'react';

// One flat figure: floor shadow, body in the room's accent colour, head. Soft light from the upper left.
export function Person({ accent }: { accent: string }) {
  const light = useId();
  return (
    <svg className="person" viewBox="0 0 120 170" role="img" aria-label="Person">
      <defs>
        <linearGradient id={light} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.28" />
          <stop offset="0.6" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <ellipse cx="60" cy="157" rx="38" ry="8" fill="rgba(0, 0, 0, 0.38)" />
      <rect x="34" y="60" width="52" height="98" rx="26" fill={accent} />
      <rect x="34" y="60" width="52" height="98" rx="26" fill={`url(#${light})`} />
      <circle cx="60" cy="34" r="24" fill="#e9c9ab" />
      <circle cx="60" cy="34" r="24" fill={`url(#${light})`} />
    </svg>
  );
}
