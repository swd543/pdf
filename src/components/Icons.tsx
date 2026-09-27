/**
 * Inline SVG icon set (stroke-based, 24px grid, currentColor).
 * Zero dependency — each icon is a tiny component.
 */
type IconProps = { class?: string };

const base = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': 2,
  'stroke-linecap': 'round' as const,
  'stroke-linejoin': 'round' as const,
  'aria-hidden': true,
};

/** Brand mark: a letterpress die stamping a page. */
export function Logo(props: IconProps) {
  return (
    <svg
      class={`logo-mark ${props.class ?? ''}`}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
    >
      <rect x="4" y="9" width="24" height="19" rx="3" fill="var(--accent)" opacity="0.15" />
      <path
        d="M8 9V6.5A2.5 2.5 0 0 1 10.5 4h11A2.5 2.5 0 0 1 24 6.5V9"
        stroke="var(--accent)"
        stroke-width="2.4"
        stroke-linecap="round"
      />
      <rect x="4" y="9" width="24" height="19" rx="3" stroke="var(--accent)" stroke-width="2.4" />
      <path
        d="M10 16h12M10 21h7"
        stroke="var(--accent)"
        stroke-width="2.4"
        stroke-linecap="round"
      />
    </svg>
  );
}

export function UploadIcon(props: IconProps) {
  return (
    <svg {...base} class={props.class}>
      <path d="M12 16V4m0 0l-4 4m4-4l4 4" />
      <path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
    </svg>
  );
}

export function DownloadIcon(props: IconProps) {
  return (
    <svg {...base} class={props.class}>
      <path d="M12 4v12m0 0l-4-4m4 4l4-4" />
      <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
    </svg>
  );
}

export function CompressIcon(props: IconProps) {
  return (
    <svg {...base} class={props.class}>
      <path d="M4 9V5a1 1 0 0 1 1-1h4M20 9V5a1 1 0 0 0-1-1h-4M4 15v4a1 1 0 0 0 1 1h4M20 15v4a1 1 0 0 1-1 1h-4" />
      <path d="M10 14l4-4m0 0h-3m3 0v3" />
    </svg>
  );
}

export function ImageIcon(props: IconProps) {
  return (
    <svg {...base} class={props.class}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="2" />
      <path d="M21 16l-5-5-8 8" />
    </svg>
  );
}

export function PdfIcon(props: IconProps) {
  return (
    <svg {...base} class={props.class}>
      <path d="M6 3h8l5 5v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
      <path d="M14 3v5h5" />
      <path d="M9 14h6M9 17h4" />
    </svg>
  );
}

export function SignIcon(props: IconProps) {
  return (
    <svg {...base} class={props.class}>
      <path d="M3 19l4-1 9.5-9.5a2.4 2.4 0 0 0-3.4-3.4L3.6 14.6 3 19z" />
      <path d="M14 6l4 4" />
      <path d="M5 21h14" />
    </svg>
  );
}

/** Merge: two documents converging into one. */
export function MergeIcon(props: IconProps) {
  return (
    <svg {...base} class={props.class}>
      <path d="M4 4h5l3 3v4" />
      <path d="M9 9h5a3 3 0 0 1 3 3v5a3 3 0 0 1-3 3h-4a3 3 0 0 1-3-3v-2" />
      <path d="M13 9l3 3 3-3" />
      <path d="M9 14v5a2 2 0 0 0 2 2h2" />
    </svg>
  );
}

/** Combine pages: a sheet split into four cells. */
export function GridIcon(props: IconProps) {
  return (
    <svg {...base} class={props.class}>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M12 4v16M4 12h16" />
    </svg>
  );
}

export function DocumentIcon(props: IconProps) {
  return (
    <svg {...base} class={props.class}>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v4h4" />
      <path d="M9 12h6M9 16h6M9 8h2" />
    </svg>
  );
}

export function TrashIcon(props: IconProps) {
  return (
    <svg {...base} class={props.class}>
      <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
    </svg>
  );
}

export function ArrowUpIcon(props: IconProps) {
  return (
    <svg {...base} class={props.class}>
      <path d="M12 19V5m0 0l-5 5m5-5l5 5" />
    </svg>
  );
}

export function ArrowDownIcon(props: IconProps) {
  return (
    <svg {...base} class={props.class}>
      <path d="M12 5v14m0 0l-5-5m5 5l5-5" />
    </svg>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <svg {...base} class={props.class}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

/** Drag grip: two columns of dots (touch + mouse reorder handle). */
export function GripIcon(props: IconProps) {
  return (
    <svg {...base} class={props.class} stroke="none" fill="currentColor">
      <circle cx="9" cy="6" r="1.6" />
      <circle cx="9" cy="12" r="1.6" />
      <circle cx="9" cy="18" r="1.6" />
      <circle cx="15" cy="6" r="1.6" />
      <circle cx="15" cy="12" r="1.6" />
      <circle cx="15" cy="18" r="1.6" />
    </svg>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <svg {...base} class={props.class}>
      <path d="M4 12.5l5 5L20 6.5" />
    </svg>
  );
}

export function AlertIcon(props: IconProps) {
  return (
    <svg {...base} class={props.class}>
      <path d="M12 3l10 18H2L12 3z" />
      <path d="M12 10v5m0 3v.5" />
    </svg>
  );
}

export function SpinnerIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" class={`spin ${props.class ?? ''}`} aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.5" opacity="0.25" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        stroke-width="2.5"
        stroke-linecap="round"
      />
    </svg>
  );
}
