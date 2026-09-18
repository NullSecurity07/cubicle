import { useId } from 'react';

// Head and shoulders in a disc; the shoulders wear the room's accent colour.
export function Avatar({ accent }: { accent: string }) {
  const clip = useId();
  return (
    <svg className="avatar" viewBox="0 0 32 32" aria-hidden="true">
      <defs><clipPath id={clip}><circle cx="16" cy="16" r="16" /></clipPath></defs>
      <g clipPath={`url(#${clip})`}>
        <rect width="32" height="32" fill="rgba(255, 255, 255, 0.09)" />
        <ellipse cx="16" cy="30" rx="11" ry="9" fill={accent} />
        <circle cx="16" cy="13" r="6" fill="#e9c9ab" />
      </g>
    </svg>
  );
}
