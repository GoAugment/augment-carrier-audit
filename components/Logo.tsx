/**
 * Augment logo — green flower icon + "augment" text wordmark.
 *
 * Sized to match goaugment.com: 16px wordmark font, ~22px icon. The icon
 * is slightly larger than the cap-height so it reads as the dominant element.
 */
export function Logo({ className = "" }: { className?: string }) {
  return (
    <div className={`inline-flex items-center gap-1.5 ${className}`}>
      <AugmentIcon size={22} />
      <span
        className="font-medium tracking-tight text-ink-900"
        style={{ fontSize: "16px", lineHeight: 1 }}
      >
        augment
      </span>
    </div>
  );
}

/** Standalone flower icon — useful for favicons, tabs, social cards, etc. */
export function AugmentIcon({ size = 22 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 80 80"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      aria-hidden
    >
      <g clipPath="url(#augclip)" clipRule="evenodd" fillRule="evenodd">
        <path
          fill="#C8EFC1"
          d="M50.724 14.111c-1.85-.766-6.238 2.467-10.723 8.348-4.486-5.881-8.874-9.114-10.724-8.348-1.85.767-2.667 6.155-1.68 13.486-7.33-.987-12.72-.17-13.486 1.68-.766 1.85 2.467 6.238 8.349 10.723-5.882 4.486-9.114 8.873-8.348 10.723.766 1.85 6.155 2.667 13.486 1.68-.988 7.33-.171 12.72 1.68 13.486 1.85.766 6.237-2.467 10.723-8.349 4.485 5.882 8.873 9.115 10.723 8.349 1.85-.767 2.667-6.155 1.68-13.486 7.33.987 12.718.17 13.485-1.68.766-1.85-2.466-6.237-8.348-10.723 5.882-4.485 9.115-8.873 8.348-10.723-.766-1.85-6.155-2.667-13.485-1.68.987-7.33.17-12.72-1.68-13.486ZM40 51c6.075 0 11-4.925 11-11s-4.925-11-11-11-11 4.925-11 11 4.925 11 11 11Z"
        />
        <path
          fill="url(#auggrad)"
          d="M40 10.302c-2.123 0-5.108 4.944-7.114 12.523C26.108 18.885 20.5 17.499 19 19c-1.5 1.5-.115 7.108 3.825 13.886-7.579 2.006-12.524 4.992-12.524 7.114 0 2.123 4.945 5.108 12.524 7.115C18.885 53.892 17.499 59.499 19 61c1.5 1.5 7.108.115 13.886-3.825 2.006 7.579 4.991 12.524 7.113 12.524 2.123 0 5.108-4.945 7.115-12.524C53.892 61.115 59.499 62.5 61 61c1.5-1.5.115-7.108-3.825-13.886 7.578-2.006 12.523-4.991 12.523-7.114 0-2.122-4.945-5.107-12.523-7.114C61.115 26.108 62.5 20.501 61 19c-1.5-1.5-7.108-.115-13.886 3.825-2.007-7.578-4.992-12.523-7.114-12.523ZM40 49.9c5.467 0 9.9-4.433 9.9-9.9 0-5.467-4.433-9.9-9.9-9.9-5.467 0-9.9 4.433-9.9 9.9 0 5.467 4.433 9.9 9.9 9.9Z"
        />
      </g>
      <defs>
        <linearGradient id="auggrad" x1="40" x2="1.643" y1="82" y2="22.89" gradientUnits="userSpaceOnUse">
          <stop stopColor="#7FCF25" />
          <stop offset="1" stopColor="#046D4A" />
        </linearGradient>
        <clipPath id="augclip">
          <rect width="80" height="80" fill="#fff" rx="40" />
        </clipPath>
      </defs>
    </svg>
  );
}
