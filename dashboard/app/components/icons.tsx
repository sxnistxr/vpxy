type IconProps = { className?: string };

export function RefreshIcon({ className = "size-3.5" }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className={className} aria-hidden="true">
      <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
      <path d="M13.5 2.5v3h-3" />
    </svg>
  );
}

export function ProviderMark({ provider, className = "size-4" }: { provider: string } & IconProps) {
  if (provider === "claude") {
    return (
      <svg viewBox="0 0 16 16" className={`${className} text-claude`} aria-hidden="true">
        {Array.from({ length: 8 }, (_, i) => (
          <rect key={i} x="7.25" y="1" width="1.5" height="6" rx="0.75" fill="currentColor" transform={`rotate(${i * 45} 8 8)`} />
        ))}
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" className={`${className} text-codex`} aria-hidden="true">
      <rect x="1.5" y="1.5" width="13" height="13" rx="4" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M5 6l2 2-2 2M8.5 10.5h2.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
