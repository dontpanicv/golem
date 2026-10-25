/** 16 px stroke icons. iOS uses the matching SF Symbols listed next to each icon. */
const paths = {
	hash: '<path d="M6 2.5 5 13.5M11 2.5l-1 11M2.5 6h11M2 10h11"/>', // number
	plus: '<path d="M8 3v10M3 8h10"/>', // plus
	search: '<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/>', // magnifyingglass
	compose: '<path d="M13 8.5V13a.5.5 0 0 1-.5.5h-9A.5.5 0 0 1 3 13V4a.5.5 0 0 1 .5-.5H8"/><path d="m12 2.5 1.5 1.5L8 9.5 6 10l.5-2z"/>', // square.and.pencil
	sidebar: '<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M6 3v10"/>', // sidebar.left
	panel: '<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M10 3v10"/>', // sidebar.right
	send: '<path d="M8 13V3M4 7l4-4 4 4"/>', // arrow.up
	attach: '<path d="m13 7.5-5 5a3 3 0 0 1-4.5-4.5l5.5-5.5a2 2 0 0 1 3 3L6.5 11a1 1 0 0 1-1.5-1.5L10 4.5"/>', // paperclip
	file: '<path d="M9 2H4.5a.5.5 0 0 0-.5.5v11a.5.5 0 0 0 .5.5h7a.5.5 0 0 0 .5-.5V5z"/><path d="M9 2v3h3"/>', // doc
	artifact: '<path d="m8 2 5.5 3v6L8 14l-5.5-3V5z"/><path d="M2.5 5 8 8l5.5-3M8 8v6"/>', // shippingbox
	preview: '<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c-2 2.5-2 8.5 0 11M8 2.5c2 2.5 2 8.5 0 11"/>', // globe
	chevron: '<path d="m5 6.5 3 3 3-3"/>', // chevron.down
	inbox: '<path d="M2.5 9h3l1 1.5h3l1-1.5h3"/><path d="M4 3.5h8l1.5 5.5v3.5a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5V9z"/>', // tray
	settings: '<circle cx="8" cy="8" r="2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/>', // gearshape
	members: '<circle cx="6" cy="5.5" r="2.5"/><path d="M1.5 13.5c.5-2.5 2.3-4 4.5-4s4 1.5 4.5 4"/><path d="M10.5 3.2a2.5 2.5 0 0 1 0 4.6M12.5 9.8c1 .7 1.7 2 2 3.7"/>', // person.2
	check: '<path d="m3.5 8.5 3 3 6-7"/>', // checkmark
	close: '<path d="m4 4 8 8M12 4l-8 8"/>', // xmark
	trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 8.5h6l.5-8.5"/>', // trash
	key: '<circle cx="5.5" cy="10.5" r="3"/><path d="m7.6 8.4 5.4-5.4M11 5l1.5 1.5"/>', // key
	logout: '<path d="M10 3H3.5v10H10M7 8h6.5M11 5.5 13.5 8 11 10.5"/>', // rectangle.portrait.and.arrow.right
	photo: '<rect x="2" y="3" width="12" height="10" rx="2"/><circle cx="6" cy="6.5" r="1.25"/><path d="m2.5 12 4-4 3 3 1.5-1.5 2.5 2.5"/>', // photo
	sound: '<path d="M3 6.5v3M5.5 4.5v7M8 2.5v11M10.5 5v6M13 7v2"/>', // waveform
	more: '<circle cx="4" cy="8" r=".75"/><circle cx="8" cy="8" r=".75"/><circle cx="12" cy="8" r=".75"/>', // ellipsis
} as const;

export type IconName = keyof typeof paths;

export function icon(name: IconName): string {
	return `<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
}
