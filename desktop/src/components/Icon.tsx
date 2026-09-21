// The icon set, drawn here rather than pulled in.
//
// The sidebar shipped with emoji (💬 🖼 🛠 🎨 📚 📁 ⚙️) -- which render
// differently on every Windows build, cannot be sized or aligned, and cannot
// inherit a stroke weight. This replaces them with one consistent grid: 24x24,
// 1.6px stroke, round caps, currentColor, so an icon is the same weight as the
// label next to it and the same colour as the state it is in.
//
// Hand-rolled for the same reason save.ts talks to the shell directly instead
// of importing a plugin's whole surface: a dozen paths do not justify a
// dependency in an app that ships as a signed installer.
type IconName =
  | 'chat'
  | 'image'
  | 'build'
  | 'design'
  | 'library'
  | 'folder'
  | 'settings'
  | 'terminal'
  | 'history'
  | 'skills'
  | 'search'
  | 'close'
  | 'check'
  | 'download'
  | 'refresh'
  | 'plus'
  | 'chevron-right'
  | 'chevron-down'
  | 'arrow-up'
  | 'stop'
  | 'file'
  | 'paperclip'
  | 'compass'
  | 'sun'
  | 'moon'
  | 'alert'
  | 'shield'
  | 'activity'
  | 'copy';

const PATHS: Record<IconName, string> = {
  chat: 'M21 12a8 8 0 0 1-8 8H8l-4 3v-4.5A8 8 0 0 1 6 5.5 8 8 0 0 1 13 4a8 8 0 0 1 8 8Z',
  image: 'M3 5.5A2.5 2.5 0 0 1 5.5 3h13A2.5 2.5 0 0 1 21 5.5v13A2.5 2.5 0 0 1 18.5 21h-13A2.5 2.5 0 0 1 3 18.5v-13Zm3.5 2.5h.01M3.5 16.5 9 11l4.5 4.5L16 13l4.5 4.5',
  build: 'M14.5 5.5a4.5 4.5 0 0 1 5.6-2.2l-3.2 3.2 1.4 1.4 3.2-3.2a4.5 4.5 0 0 1-6 5.6L6.8 19a2 2 0 1 1-2.8-2.8l8.7-8.7a4.5 4.5 0 0 1 1.8-2Z',
  design: 'M12 3a9 9 0 1 0 0 18h1.5a2.5 2.5 0 0 0 0-5H13a2 2 0 0 1 0-4h4a4 4 0 0 0 4-4 4 4 0 0 0-4-4h-5Zm-4 8h.01M9.5 7h.01M14 7.5h.01',
  library: 'M4 5.5A2.5 2.5 0 0 1 6.5 3H19v18H6.5A2.5 2.5 0 0 1 4 18.5v-13Zm4-2.5v18M20 8h-1M20 16h-1',
  folder: 'M3 7.5A2.5 2.5 0 0 1 5.5 5h3.2l2 2.5h7.8A2.5 2.5 0 0 1 21 10v6.5A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5v-9Z',
  settings: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm8-3.5a8 8 0 0 0-.2-1.7l2-1.5-2-3.4-2.3 1a8 8 0 0 0-2.9-1.7L14.2 2h-4l-.4 2.7A8 8 0 0 0 6.9 6.4l-2.3-1-2 3.4 2 1.5A8 8 0 0 0 4.4 12c0 .6.1 1.2.2 1.7l-2 1.5 2 3.4 2.3-1a8 8 0 0 0 2.9 1.7l.4 2.7h4l.4-2.7a8 8 0 0 0 2.9-1.7l2.3 1 2-3.4-2-1.5c.1-.5.2-1.1.2-1.7Z',
  terminal: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm4 4 3 3-3 3m5.5 1H17',
  history: 'M3.5 12a8.5 8.5 0 1 0 2.6-6.1M3.5 4.5V9H8m4-3.5V12l3.5 2',
  skills: 'M12 3.5 13.7 9l5.8 1.7-5.8 1.7L12 18l-1.7-5.6L4.5 10.7 10.3 9 12 3.5Zm7 9.5.8 2.4L22 16l-2.2.6L19 19l-.8-2.4L16 16l2.2-.6L19 13Z',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm5.2-1.8L21 21',
  close: 'M6 6l12 12M18 6 6 18',
  check: 'M4.5 12.5 9 17 19.5 6.5',
  download: 'M12 3.5v11m0 0 4-4m-4 4-4-4M4.5 19.5h15',
  refresh: 'M20 11.5A8 8 0 1 0 17.4 6M20 4v5h-5',
  plus: 'M12 5v14M5 12h14',
  copy: 'M9 9.5A2.5 2.5 0 0 1 11.5 7H19a2 2 0 0 1 2 2v9.5A2.5 2.5 0 0 1 18.5 21H11a2 2 0 0 1-2-2V9.5ZM6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1',
  'chevron-right': 'M9.5 5.5 16 12l-6.5 6.5',
  'chevron-down': 'M5.5 9.5 12 16l6.5-6.5',
  'arrow-up': 'M12 19.5V5m0 0-6.5 6.5M12 5l6.5 6.5',
  stop: 'M6.5 6.5h11v11h-11z',
  file: 'M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9l-6-6Zm0 0v6h6',
  paperclip: 'M20 11.5 12.3 19a4 4 0 0 1-5.7-5.7l7.8-7.7a2.7 2.7 0 0 1 3.8 3.8l-7.8 7.7a1.3 1.3 0 0 1-1.9-1.9l7.1-7',
  compass: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm3.6-12.6-2.1 5-5 2.1 2.1-5 5-2.1Z',
  sun: 'M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9ZM12 2.5v2m0 15v2M4.2 4.2l1.4 1.4m12.8 12.8 1.4 1.4M2.5 12h2m15 0h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  moon: 'M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z',
  alert: 'M12 8.5v5m0 3h.01M10.3 4.4 2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.4a2 2 0 0 0-3.4 0Z',
  shield: 'M12 3 5 5.5v6c0 4.2 2.9 7.9 7 9.5 4.1-1.6 7-5.3 7-9.5v-6L12 3Z',
  activity: 'M3.5 12.5h4l2.5-6 4 12 2.5-6h4',
};

export interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
}

export default function Icon({ name, size = 16, className }: IconProps) {
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

export type { IconName };
