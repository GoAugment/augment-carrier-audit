/**
 * Augment wordmark — simplified clover icon + lowercase wordmark.
 * Inline SVG so it ships in HTML and is themeable.
 */
export function Logo({ className = "" }: { className?: string }) {
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <svg
        width="22"
        height="22"
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden
      >
        <circle cx="10" cy="10" r="6" className="fill-augment-500" />
        <circle cx="22" cy="10" r="6" className="fill-augment-600" />
        <circle cx="10" cy="22" r="6" className="fill-augment-600" />
        <circle cx="22" cy="22" r="6" className="fill-augment-700" />
      </svg>
      <span className="text-base font-semibold tracking-tight text-ink-900">augment</span>
    </div>
  );
}
