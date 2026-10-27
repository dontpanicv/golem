/** 16 px stroke icons. iOS uses the matching SF Symbols listed next to each icon. */
const paths = {
  hash: '<path d="M6 2.5 5 13.5M11 2.5l-1 11M2.5 6h11M2 10h11"/>', // number
  plus: '<path d="M8 3v10M3 8h10"/>', // plus
  search: '<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/>', // magnifyingglass
  bell: '<path d="M4.5 11V7a3.5 3.5 0 0 1 7 0v4l1 1.5h-9z"/><path d="M6.75 14h2.5"/>', // bell
  compose:
    '<path d="M13 8.5V13a.5.5 0 0 1-.5.5h-9A.5.5 0 0 1 3 13V4a.5.5 0 0 1 .5-.5H8"/><path d="m12 2.5 1.5 1.5L8 9.5 6 10l.5-2z"/>', // square.and.pencil
  sidebar:
    '<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M6 3v10"/>', // sidebar.left
  panel:
    '<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M10 3v10"/>', // sidebar.right
  send: '<path d="M8 13V3M4 7l4-4 4 4"/>', // arrow.up
  attach:
    '<path d="m13 7.5-5 5a3 3 0 0 1-4.5-4.5l5.5-5.5a2 2 0 0 1 3 3L6.5 11a1 1 0 0 1-1.5-1.5L10 4.5"/>', // paperclip
  file: '<path d="M9 2H4.5a.5.5 0 0 0-.5.5v11a.5.5 0 0 0 .5.5h7a.5.5 0 0 0 .5-.5V5z"/><path d="M9 2v3h3"/>', // doc
  artifact:
    '<path d="m8 2 5.5 3v6L8 14l-5.5-3V5z"/><path d="M2.5 5 8 8l5.5-3M8 8v6"/>', // shippingbox
  preview:
    '<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c-2 2.5-2 8.5 0 11M8 2.5c2 2.5 2 8.5 0 11"/>', // globe
  chevron: '<path d="m5 6.5 3 3 3-3"/>', // chevron.down
  back: '<path d="M9.5 4 5.5 8l4 4"/>', // chevron.left
  forward: '<path d="m6.5 4 4 4-4 4"/>', // chevron.right
  download: '<path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10"/>', // arrow.down.to.line
  disclosure:
    '<path d="M6.5 5.25v5.5L10.25 8z" fill="currentColor" stroke="none"/>', // arrowtriangle.right.fill
  inbox:
    '<path d="M2.5 9h3l1 1.5h3l1-1.5h3"/><path d="M4 3.5h8l1.5 5.5v3.5a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5V9z"/>', // tray
  settings:
    '<path d="M6.71 3.17L7.1 1.56A6.5 6.5 0 0 1 8.9 1.56L9.29 3.17A5 5 0 0 1 10.5 3.67L11.91 2.81A6.5 6.5 0 0 1 13.19 4.09L12.33 5.5A5 5 0 0 1 12.83 6.71L14.44 7.1A6.5 6.5 0 0 1 14.44 8.9L12.83 9.29A5 5 0 0 1 12.33 10.5L13.19 11.91A6.5 6.5 0 0 1 11.91 13.19L10.5 12.33A5 5 0 0 1 9.29 12.83L8.9 14.44A6.5 6.5 0 0 1 7.1 14.44L6.71 12.83A5 5 0 0 1 5.5 12.33L4.09 13.19A6.5 6.5 0 0 1 2.81 11.91L3.67 10.5A5 5 0 0 1 3.17 9.29L1.56 8.9A6.5 6.5 0 0 1 1.56 7.1L3.17 6.71A5 5 0 0 1 3.67 5.5L2.81 4.09A6.5 6.5 0 0 1 4.09 2.81L5.5 3.67z"/><circle cx="8" cy="8" r="2"/>', // gearshape
  members:
    '<circle cx="6" cy="5.5" r="2.5"/><path d="M1.5 13.5c.5-2.5 2.3-4 4.5-4s4 1.5 4.5 4"/><path d="M10.5 3.2a2.5 2.5 0 0 1 0 4.6M12.5 9.8c1 .7 1.7 2 2 3.7"/>', // person.2
  check: '<path d="m3.5 8.5 3 3 6-7"/>', // checkmark
  close: '<path d="m4 4 8 8M12 4l-8 8"/>', // xmark
  trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 8.5h6l.5-8.5"/>', // trash
  key: '<circle cx="5.5" cy="10.5" r="3"/><path d="m7.6 8.4 5.4-5.4M11 5l1.5 1.5"/>', // key
  logout: '<path d="M10 3H3.5v10H10M7 8h6.5M11 5.5 13.5 8 11 10.5"/>', // rectangle.portrait.and.arrow.right
  photo:
    '<rect x="2" y="3" width="12" height="10" rx="2"/><circle cx="6" cy="6.5" r="1.25"/><path d="m2.5 12 4-4 3 3 1.5-1.5 2.5 2.5"/>', // photo
  sound: '<path d="M3 6.5v3M5.5 4.5v7M8 2.5v11M10.5 5v6M13 7v2"/>', // waveform
  more: '<circle cx="4" cy="8" r=".75"/><circle cx="8" cy="8" r=".75"/><circle cx="12" cy="8" r=".75"/>', // ellipsis
  info: '<circle cx="8" cy="8" r="5.5"/><path d="M8 7.5V11M8 5.25v.01"/>', // info.circle
  play: '<path d="M5 3.5v9l7-4.5z"/>', // play
  stop: '<rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" stroke="none"/>', // stop.fill
  link: '<path d="M7 9a2.5 2.5 0 0 0 3.5 0l2-2A2.5 2.5 0 0 0 9 3.5l-.75.75M9 7a2.5 2.5 0 0 0-3.5 0l-2 2A2.5 2.5 0 0 0 7 12.5l.75-.75"/>', // link
  lock: '<rect x="3.5" y="7" width="9" height="6.5" rx="1"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>', // lock
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name }: { name: IconName }) {
  return (
    <svg
      aria-hidden="true"
      className="icon"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: the paths are the constants above
      dangerouslySetInnerHTML={{ __html: paths[name] }}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
      viewBox="0 0 16 16"
    />
  );
}
