import type { JSX, VNode } from 'preact';

// Simple, consistent line glyphs (24 viewbox, 1.7 stroke, round).
// Ported from the design handoff's ui.jsx icon set.

export type IconName =
  | 'lock' | 'plus' | 'search' | 'left' | 'right' | 'down' | 'cal' | 'book'
  | 'books' | 'tag' | 'mic' | 'image' | 'check' | 'quote' | 'bold' | 'italic'
  | 'list' | 'checklist' | 'heading' | 'settings' | 'more' | 'moon' | 'feather'
  | 'pin' | 'clock' | 'copy' | 'eye' | 'eyeoff' | 'shield' | 'arrowR' | 'sun'
  | 'grid' | 'timeline' | 'x' | 'video' | 'olist' | 'code' | 'divider' | 'trash'
  | 'file' | 'download' | 'math' | 'monitor' | 'table' | 'link' | 'edit'
  | 'rowplus' | 'colplus' | 'rowminus' | 'colminus' | 'key' | 'info' | 'film';

interface IconProps {
  name: IconName;
  size?: number;
  stroke?: number;
  style?: JSX.CSSProperties;
  color?: string;
  /** Mirror in RTL locales — for glyphs whose direction means forward/back
      (chevrons, arrows), not for inherently symmetric or physical shapes. */
  dirFlip?: boolean;
}

export function Icon({ name, size = 20, stroke = 1.7, style = {}, color = 'currentColor', dirFlip }: IconProps): VNode {
  const P = {
    fill: 'none' as const,
    stroke: color,
    strokeWidth: stroke,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  const paths: Record<IconName, VNode> = {
    lock: <><rect x="5" y="11" width="14" height="9" rx="2" {...P} /><path d="M8 11V8a4 4 0 0 1 8 0v3" {...P} /></>,
    plus: <><path d="M12 5v14M5 12h14" {...P} /></>,
    search: <><circle cx="11" cy="11" r="6.5" {...P} /><path d="M16 16l4 4" {...P} /></>,
    left: <><path d="M15 5l-7 7 7 7" {...P} /></>,
    right: <><path d="M9 5l7 7-7 7" {...P} /></>,
    down: <><path d="M5 9l7 7 7-7" {...P} /></>,
    cal: <><rect x="4" y="5" width="16" height="16" rx="2.5" {...P} /><path d="M4 9h16M8 3v4M16 3v4" {...P} /></>,
    book: <><path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3V4z" {...P} /><path d="M5 4v13a3 3 0 0 1 3-3h11" {...P} /></>,
    books: <><rect x="4" y="4" width="6" height="16" rx="1.5" {...P} /><rect x="13" y="7" width="6" height="13" rx="1.5" {...P} /></>,
    tag: <><path d="M4 12V5a1 1 0 0 1 1-1h7l8 8-8 8-8-8z" {...P} /><circle cx="8.5" cy="8.5" r="1.3" fill={color} stroke="none" /></>,
    mic: <><rect x="9" y="3" width="6" height="11" rx="3" {...P} /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" {...P} /></>,
    image: <><rect x="4" y="5" width="16" height="14" rx="2.5" {...P} /><circle cx="9" cy="10" r="1.6" {...P} /><path d="M5 17l4.5-4 3.5 3 3-2.5 3 3" {...P} /></>,
    check: <><path d="M5 12.5l4.5 4.5L19 6.5" {...P} /></>,
    quote: <><path d="M9 7c-2.5 1-4 3-4 6h4v4H4v-6c0-3 1.5-5 5-6zM20 7c-2.5 1-4 3-4 6h4v4h-5v-6c0-3 1.5-5 5-6z" {...P} /></>,
    bold: <><path d="M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z" {...P} /></>,
    italic: <><path d="M10 5h7M7 19h7M14 5l-4 14" {...P} /></>,
    list: <><path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" {...P} /></>,
    checklist: <><path d="M11 6h9M11 12h9M11 18h9" {...P} /><path d="M4 6.5l1.3 1.3L7.5 5M4 17.5l1.3 1.3L7.5 16" {...P} /></>,
    heading: <><path d="M6 5v14M16 5v14M6 12h10" {...P} /></>,
    settings: <><circle cx="12" cy="12" r="3" {...P} /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" {...P} /></>,
    more: <><circle cx="5" cy="12" r="1.4" fill={color} stroke="none" /><circle cx="12" cy="12" r="1.4" fill={color} stroke="none" /><circle cx="19" cy="12" r="1.4" fill={color} stroke="none" /></>,
    moon: <><path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z" {...P} /></>,
    feather: <><path d="M20 4C13 4 7 8 6 16l-2 4M9 13h7M6.5 16.5L17 6" {...P} /></>,
    pin: <><path d="M12 21s6-5.3 6-10a6 6 0 1 0-12 0c0 4.7 6 10 6 10z" {...P} /><circle cx="12" cy="11" r="2.2" {...P} /></>,
    clock: <><circle cx="12" cy="12" r="8" {...P} /><path d="M12 8v4.5l3 2" {...P} /></>,
    copy: <><rect x="9" y="9" width="11" height="11" rx="2" {...P} /><path d="M5 15V5a2 2 0 0 1 2-2h8" {...P} /></>,
    eye: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" {...P} /><circle cx="12" cy="12" r="2.6" {...P} /></>,
    eyeoff: <><path d="M3 3l18 18M10.6 10.6a2.6 2.6 0 0 0 3.6 3.6M9.3 5.3A9.7 9.7 0 0 1 12 5c6.5 0 10 7 10 7a16 16 0 0 1-3.5 4.2M6 6.5A16 16 0 0 0 2 12s3.5 7 10 7a9.6 9.6 0 0 0 2.4-.3" {...P} /></>,
    shield: <><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" {...P} /><path d="M9 12l2 2 4-4" {...P} /></>,
    arrowR: <><path d="M4 12h15M13 6l6 6-6 6" {...P} /></>,
    sun: <><circle cx="12" cy="12" r="4" {...P} /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19" {...P} /></>,
    grid: <><rect x="4" y="4" width="6.5" height="6.5" rx="1.5" {...P} /><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" {...P} /><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" {...P} /><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" {...P} /></>,
    timeline: <><path d="M6 4v16" {...P} /><circle cx="6" cy="8" r="1.6" {...P} /><circle cx="6" cy="16" r="1.6" {...P} /><path d="M11 8h9M11 16h9" {...P} /></>,
    x: <><path d="M6 6l12 12M18 6L6 18" {...P} /></>,
    video: <><rect x="3" y="6.5" width="12.5" height="11" rx="2.5" {...P} /><path d="M15.5 10.8l5-3v8.4l-5-3" {...P} /></>,
    film: <><rect x="3" y="4.5" width="18" height="15" rx="2.5" {...P} /><path d="M7.5 4.5v15M16.5 4.5v15M3 12h18M3 8.25h4.5M3 15.75h4.5M16.5 8.25H21M16.5 15.75H21" {...P} /></>,
    olist: <><path d="M10 6h10M10 12h10M10 18h10" {...P} /><path d="M4 6h1v4M4 10h2" {...P} /><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1" {...P} /></>,
    code: <><path d="M9 8l-4 4 4 4M15 8l4 4-4 4" {...P} /></>,
    divider: <><path d="M4 12h16M9 6h6M9 18h6" {...P} /></>,
    trash: <><path d="M5 7h14M10 7V5.5A1.5 1.5 0 0 1 11.5 4h1A1.5 1.5 0 0 1 14 5.5V7M7.5 7l.6 11.2a2 2 0 0 0 2 1.8h3.8a2 2 0 0 0 2-1.8L16.5 7" {...P} /><path d="M10.3 11v5.5M13.7 11v5.5" {...P} /></>,
    edit: <><path d="M4 20h4L18.5 9.5a2 2 0 0 0 0-2.8l-1.2-1.2a2 2 0 0 0-2.8 0L4 16v4z" {...P} /><path d="M13.3 6.7l4 4" {...P} /></>,
    file: <><path d="M6.5 3.5h7L18.5 8.5v11a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1z" {...P} /><path d="M13.5 3.5v5h5" {...P} /></>,
    download: <><path d="M12 4v11M7.5 11l4.5 4.5L16.5 11" {...P} /><path d="M5 19.5h14" {...P} /></>,
    math: <><path d="M3.5 13.5h2.5l2.5 5L13 5.5h7.5" {...P} /><path d="M14.5 12.5l5 6M19.5 12.5l-5 6" {...P} /></>,
    monitor: <><rect x="3.5" y="5" width="17" height="12" rx="2" {...P} /><path d="M9.5 20.5h5M12 17v3.5" {...P} /></>,
    table: <><rect x="3.5" y="5" width="17" height="14" rx="2" {...P} /><path d="M3.5 10h17M9.5 10v9M15.5 10v9" {...P} /></>,
    link: <><path d="M10.5 13.5a4 4 0 0 0 5.6.4l2.6-2.3a4 4 0 0 0-5.3-6l-1.5 1.3" {...P} /><path d="M13.5 10.5a4 4 0 0 0-5.6-.4l-2.6 2.3a4 4 0 0 0 5.3 6l1.5-1.3" {...P} /></>,
    rowplus: <><rect x="3.5" y="4.5" width="17" height="8" rx="2" {...P} /><path d="M3.5 8.5h17M12 15.5v5M9.5 18h5" {...P} /></>,
    colplus: <><rect x="3.5" y="3.5" width="8" height="17" rx="2" {...P} /><path d="M7.5 3.5v17M15.5 12h5M18 9.5v5" {...P} /></>,
    rowminus: <><rect x="3.5" y="4.5" width="17" height="8" rx="2" {...P} /><path d="M3.5 8.5h17M9.5 18h5" {...P} /></>,
    colminus: <><rect x="3.5" y="3.5" width="8" height="17" rx="2" {...P} /><path d="M7.5 3.5v17M15.5 12h5" {...P} /></>,
    key: <><circle cx="8" cy="14.5" r="4.5" {...P} /><path d="M11.2 11.3L19.5 3M15.5 7l3 3M13 9.5l2 2" {...P} /></>,
    info: <><circle cx="12" cy="12" r="8.5" {...P} /><path d="M12 11v5.2" {...P} /><circle cx="12" cy="7.8" r="1.1" fill={color} stroke="none" /></>,
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      class={dirFlip ? 'dir-flip' : undefined}
      style={{ display: 'block', flexShrink: 0, ...style }}
    >
      {paths[name]}
    </svg>
  );
}
