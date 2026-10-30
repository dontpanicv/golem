# Golem components

Every value is measured from Linear's light and dark themes (Inter 4.1, the same font file) and lives in
`tokens.json`.
Every component exists on the web (`public/styles.css`, `web/ui/`) and on iOS
(`ios/Golem/Design/`) with the same behavior. The web looks like Linear's web app: native selects and pickers are never
used there; menus, selects, switches, and checkboxes are our own. iOS looks like Linear's iOS app; see [iOS](#ios).

## Type and color

- Inter Variable, line height `normal` for controls, `font-display: block`. Pages link styles and scripts with a hash
  of their content, and the server keeps them and the font in the browser for good, so text never paints in a
  fallback font first.
- Text: `text` for titles and values, `textSecondary` for controls and body, `textTertiary` for descriptions,
  inactive navigation, and meta, `textQuaternary` for placeholders and times.
- Weights: `book` (450) for body and menus, `medium` (500) for labels, navigation, and buttons, `strong` (550) for
  the workspace name, `regular` (400) for field and select values.
- Icons: 16 px in menus and lists, 14 px in buttons and navigation; strokes stay 1.5 px at every size.
- Dark theme: Linear lifts each layer, so roles that share one light color split in dark. Cards, fields, buttons,
  and dialogs use `surfaceRaised`; a select trigger on a card `surfaceControl`; action menus, tooltips, and toasts
  `surfaceMenu`; select menus `surfaceListbox`; the composer `surfaceComposer`. Controls take `ringControl`, cards
  `ring`. `ghostHover` is translucent, so a ghost button fits every surface. Shadows have their own dark layers.

## Motion

- Hover states start at once and fade out in `duration.fast` (150 ms, `ease`): every transition has a zero duration
  while hovered or pressed. Hover styles apply only to fine pointers.
- Menus, selects, and dialogs open and close at once.
- Tooltips spring: opacity reaches 1 in 40 ms while the scale goes from 0.98 to 1 in 48 ms; on close the scale goes
  back in 33 ms and the opacity fades in 180 ms after a 27 ms hold. CSS `linear()` curves trace Linear's spring.
- Toasts slide up from their own height and fade in `duration.toast` (400 ms, `ease`), and leave the same way.
- Reduced motion: no transitions or animations.

## Buttons

| Variant | Look | Hover |
| --- | --- | --- |
| secondary | `surfaceRaised`, `textSecondary`, a 0.5 px `ringControl` and shadow `low` | `surfaceHover`, `ringHover` |
| primary | `accent`, `onAccent`, shadow `low` | `accentHover` |
| ghost | transparent, `textTertiary` | `ghostHover`; `text` |
| danger | ghost with `danger` text | `dangerSubtle` |

- All are pills (`radius.full`): 32 high, 12 px side padding, `fontSize.md` `medium`. A leading 14 px icon takes the
  left padding to 10 px and sits 6 px from the label.
- `small`: 28 high, 10 px padding (8 px before an icon), `fontSize.sm`. `large`: 40 high, full width.
- Icon buttons are circles: 28 (`icon`) or 24 (`tiny`), with a 14 px icon.
- Pressed (`aria-pressed`) and open (`aria-expanded`) ghost buttons keep the hover look. Disabled: 60 % opacity.
- Busy: while a message sends or files upload, the send or upload button shows a 14 px spinner in place of its icon
  and takes no clicks.
- Focus: 1 px `accent` outline, offset 2 px. The cursor stays the arrow, as in Linear.
- iOS keeps the visual size and extends the touch target to 44 pt.

## Text field

- 32 high, padding 6 × 12, `radius.md`, `surfaceRaised`, 0.5 px `borderStrong`, `fontSize.md` `regular` `text`.
  Hover: `borderHover`. Focus: 1 px `accent` outline at offset −1 px (iOS: a 1 pt `accent` border).
- Placeholder `textQuaternary`. Large (sign-in, search): 40 high, `fontSize.lg`.
- Label above: `fontSize.md` `medium` `textSecondary` on a 24 px line, 4 px gap. Errors use a toast.
- In a settings row a field is 180 wide.

## Select

- Trigger: 30 high with 1 px margins, `radius.md`, padding 1 × 28 × 1 × 10, `surfaceControl`, `ringControl` and
  shadow `low`, value `fontSize.md` `regular` `textSecondary`, a 16 px chevron 7 px from the right. Hover:
  `surfaceControlHover`, `ringHover`.
- The menu opens over the trigger with the selected option centered on it and its text on the value, as macOS menus
  do; at least as wide as the trigger. It moves only to stay 8 px inside the window.
- Menu: `surfaceListbox`, 4 px vertical padding, a 0.5 px `ringListbox` ring and shadow `menu`, `radius.xl`.
  Options: 32 high, padding 0 × 35 × 0 × 12, `regular`; the highlight is inset 4 px, `radius.md`, `listboxHover`. The selected option
  shows a 16 px check 12 px from the right.
- Keyboard: Enter, Space, or ↓ opens; ↑ ↓ Home End move; Enter selects; Escape closes; typing jumps to a match.
- Selecting closes the menu and updates the value. `autosubmit` submits the surrounding form at once.

## Menu

Used by the workspace switcher and action menus.

- `surfaceMenu`, 0.5 px `borderMenu` border, `radius.xl`, shadow `menu`, 6 px vertical padding, min width
  `size.menuMinWidth`. Opens 4 px below its trigger, start- or end-aligned, or above when there is no room.
- Item: 32 high, padding 0 × 18 × 0 × 14, `fontSize.md` `book` `textSecondary`, a 16 px icon 8 px before the label
  in the same color. The highlight is inset 6 px, `radius.md`, `menuHover`, and turns the text `text`.
- A click highlights nothing until the pointer moves; the keyboard highlights the first item.
- A current item shows a 16 px check at the right. Shortcuts are plain text: `fontSize.xs` `medium` `textTertiary`.
- Separator: 0.5 px `borderSubtle` with 6 px above and below. Section label: `fontSize.sm` `medium` `textTertiary`,
  28 high.

## Switch

- Track 30 × 20, `radius.full`. Off: `switchTrack`, hover `switchTrackHover`. On: `accent`, hover `accentHover`. The
  color changes in 150 ms ease-out.
- Knob 14, `onAccent`, 3 px from the edges; it travels 10 px. Its leading and trailing edges move in 100 ms
  ease-out, the trailing edge 50 ms later, so it stretches on the way. Under the pointer it widens 2 px toward the
  middle.
- The touch target is 42 × 32 on the web and 44 pt on iOS. `autosubmit` submits the form on change.

## Checkbox

- 14 square, `radius.xxs`, 1 px `borderControl`, transparent; hover turns the border `accentHover`.
- Checked: `accent` fill and border, a white 10 × 9 check. Colors change in 80 ms ease-out.
- Label to the right, `fontSize.md` `textSecondary`, 8 px gap; the whole row toggles.

## Tooltip

- Shows 450 ms after the pointer or keyboard focus arrives and hides when it leaves. Within 300 ms of one closing,
  the next shows at once and the old one goes at once.
- Padding 5 × 8, `radius.md`, `surfaceMenu`, 0.5 px `borderMenu`, shadow `low`. Text `fontSize.xs` `book`
  `textSecondary` on a 16.5 px line; an optional keycap 8 px after it.
- Placed 8 px below the target, centered, or above when there is no room. Motion as above.
- iOS has no hover: icon buttons carry accessibility labels instead.

## Dialog

- `overlay` backdrop. Card `surfaceRaised`, 0.5 px `borderDialog`, `radius.xl`, shadow `modal`, width
  min(`size.dialog`, 100 % − 32), centered over the panel.
- Header: padding 16 × 48 × 16 × 16, title `fontSize.lg` `book` on a 23 px line, a ghost close icon button 16 px from
  the right. Body: padding 12 × 16, fields 12 px apart. Footer: padding 16 × 16 × 12, buttons right-aligned 8 px
  apart, secondary then primary. Escape and the backdrop close it.
- iOS: a sheet sized to its content with the same card.

## Toast

- Bottom right on the web, 24 px from the window edges; top on iOS. Width `size.toast`, padding 12, `radius.xl`,
  `surfaceMenu`, a 0.5 px `ringControl` and shadow `menu`.
- A 16 px icon (info in `textSecondary`, success in `success`, error in `danger`), the text in `fontSize.md`
  `medium` `text`, and a 12 px close mark in `textTertiary` (hover `text`).
- Goes after 4 s or on a click; the pointer on it keeps it.

## Sidebar

- 244 wide on the canvas, 12 px side padding. It starts with Golem, with no workspace name above it.
- Item: 28 high, 1 px apart, padding 0 × 9 × 0 × 8, `radius.md`, a 14 px icon 6 px before the label,
  `fontSize.md` `medium` `textTertiary`. Hover: `fillHover` at once and `text` in 150 ms. Current: `fillActive`, `text`.
  Count: `fontSize.xs` `book`. A channel with an emoji shows it in place of the `#` icon, `fontSize.sm`, centered in
  the 14 px slot (iOS: in the icon's frame).
- Private channels are in their own group, Private, after Channels, each with a 14 px lock after its name in
  `textTertiary` (iOS too). The group shows only when the person has a private channel.
- Groups are 16 px apart. Section header: 28 high, the label 9 px in, `fontSize.sm` `medium` `textTertiary`; its action
  button shows on hover or focus (always on touch screens).
- Threads sit under their channel, indented 19 px with 6 px inner padding; each shows its settle button on hover or
  focus (always on touch screens). Settled threads leave the active lists and appear in a collapsed Settled shelf at
  the bottom, newest settlement first; its disclosure arrow turns 90° in 150 ms. A settled thread remains readable
  and can receive messages.

## Panel and header

- The panel sits 8 px from the window, `surface`, 0.5 px `border`, `radius.xl`, shadow `low`.
- Header: 44 high including its 0.5 px `border` bottom line, padding 0 × 8 × 0 × 18, title `fontSize.md` `medium`
  `textSecondary`, the parents of a breadcrumb in `textTertiary`. Actions are ghost icon buttons.

## Tabs

- Pills 28 high, padding 0 × 10, `fontSize.sm` `medium`, 8 px apart. Unselected: `surfaceRaised`, `ringControl`, shadow
  `low`, `textTertiary`; hover `ghostHover` and `ringHover`. Selected: `fillSelected`, `ringControl` without
  shadow, `text`.

## Settings page

- A 640 px column, 64 px from the top of the panel, 40 px side margins. Page title `fontSize.xxl` `medium`, 32 px line,
  −0.16 px letter spacing, 32 px above the first section. Sections are 48 px apart; section title `fontSize.lg`
  `medium` on a 23 px line, 16 px above its card. Titles and text sit 16 px in, level with the row text.
- Card: `surfaceRaised`, `radius.lg`, a 0.5 px `ring` and shadow `low`. Rows are separated by 0.5 px `ring` lines
  inset 16 px.
- Row: min 60 high, padding 16, 12 px gaps, label `fontSize.md` `medium` `text`, description `fontSize.sm` `book`
  `textTertiary` 3 px below, control at the right. Compact rows (lists of people, machines, runs) are min 44 high with
  8 px vertical padding.
- A leading icon sits in a 32 px `fillIcon` square with `radius.sm`; a leading avatar is 24 px.
- A text field for long text, such as the workspace's facts, fills the card with 16 px padding, min 160 high, a 1.5
  line height, and its Save button at the bottom right.
- Text in a section, such as a channel summary: `fontSize.md` `textSecondary` on a 22 px line, with its line breaks.

## Badge, keycap, and avatar

- Badge: a pill 24 high, padding 0 × 8, 0.5 px `borderStrong`, a 9 px dot (`textQuaternary`, or the tone's color)
  6 px before the label in `fontSize.sm` `book` `textTertiary`.
- Keycap: min 18 × 17, padding 2, `radius.xs`, 0.5 px `borderSubtle`, `fontSize.xs` `regular` `textTertiary`,
  slashed zero. In menus a shortcut is plain text.
- Avatar: a 24 px circle with the initial in `fontSize.xs` `medium` `onAccent` on one of the `avatar` colors, picked
  by the sum of the name's code points. Workspaces use `accent` in a `radius.sm` square;
  Golem shows its face, `design/icon.svg`, in that square.

## Lists

- Rows: min 32 high, padding 0 × 8, `radius.md`, a 16 px `textTertiary` icon 8 px before the name in `fontSize.md`
  `medium` `text`, meta at the right in `fontSize.sm` `book` `textTertiary`. Rows that open something turn
  `fillSubtle` under the pointer at once.

## Inbox

- The sidebar's Inbox item, after Golem, shows the unread count. The page lists notifications newest first as search
  rows: an icon (the thread's, or `hash` for a channel), the title, the text in `textTertiary`, the day, and a
  `size.dot` `accent` dot while unread. A click reads it and opens its thread or channel. The header's check button
  reads them all. iOS has the same screen in the More menu and the sidebar, with the count at the right of its row.

## Conversation

- Message: avatar, then the author in `medium` `text` and the time in `fontSize.sm` `textQuaternary`; the text in
  `fontSize.lg` `book` `textSecondary` on a 1.6 line with −0.1 px letter spacing and its line breaks.
- Work log: between the meta and the text of an agent's answer, what the agent did before it. A summary in
  `fontSize.md` `textTertiary` with tabular numbers, "Working for 12s" counting up each second while it works, then
  "Worked for 14s", or "Stopped after 14s" when someone stopped it, with a disclosure arrow that turns 90° when open;
  hover (web) turns it `text`. The steps sit under it in `fontSize.md` behind a 1 px `border` line, 8 px in, at most
  `size.workLog` high, scrolling, and keeping the newest step in view until the person scrolls up: thoughts in
  `textQuaternary`, words in `textSecondary`, and each tool call as its name in `medium` `textTertiary` (`danger` when
  it failed, pulsing while it runs), then the thread it reached or its arguments on one truncated line in
  `textQuaternary`. A tool call opens to show its arguments and result in `fontSize.sm` monospace on `fillSubtle`,
  `radius.sm`. Calls of one tool in a row fold into one row, "Web search 4 times", open while one of them runs. The log
  is open while the agent works and folds when the answer comes; a person's choice to open or fold it stays until
  then.
- Working spinner: a 14 px ring in `textQuaternary` with an open side, turning every 0.8 s, after a thread in the
  sidebar, in a channel's thread list, and after each thread link while that thread's agent works. iOS shows a mini
  progress view in rows, and "· working" after a thread link.
- Stop: a tiny secondary button with a stop icon before Send, only while the agent works. It stops the threads the agent asked
  for something, which still work on that message, too.
- Approval: above the composer, for the person it asks only, while the agent waits for them to allow a change on a
  machine. `surfaceRaised`, a 0.5 px `ringControl`, shadow `low`, `radius.lg`, padding 12; the action in
  `fontSize.md` monospace `textSecondary`, wrapped; 8 px below, at the end, small buttons: danger "Deny", secondary
  "Allow for this turn", primary "Allow". A push says "Allow? <action>" and opens the thread. iOS shows the same card
  above the composer row, with 44 pt touch targets.
- The sidebar shows the threads and channels that agents start while they work, without a reload.
- Composer: `surfaceComposer`, `radius.lg`, padding 12, shadow `low`, no focus ring. The text is `fontSize.lg` on a
  24 px line with padding 2 × 6; placeholder `textQuaternary`. Actions sit 8 px below: a tiny ghost attach button
  and a tiny primary send button.

## Thread link

- Agents write a thread as `[title](thread:<id>)` in a message. It shows as the title in `accent`, no underline;
  hover (web) turns it `accentHover` and underlined. Clicking or tapping opens the thread in the app.

## Channel threads

- Active threads appear newest first under their channels in the sidebar and on the channel page, each with its
  settle button. Settled threads leave the active lists; a settled thread can be un-settled.

## File chip

- A file attached to a message, or picked in the composer: 28 high (44 pt touch target on iOS), padding 0 × 10 × 0 × 8,
  `radius.md`, `fillSubtle`, a 0.5 px `ring`, a 14 px paperclip in `textTertiary`, the name in `fontSize.sm`
  `textSecondary`, cut with an ellipsis at 240 wide. Chips wrap with a 4 px gap.
- In a message a picture shows itself instead of a chip, from its JPEG (`/files/:fileId/picture`): at most 320 wide
  and 240 high, `radius.md`, a 0.5 px `ring`. A picture that the server cannot convert shows as a chip.
- In a message the chip opens the file preview; hover (web) turns it `fillHover` and the name `text`. Picked files show
  above the composer's buttons until the message is sent, each with a close icon in `textTertiary` (hover `text`)
  that takes the file out.
- The composer and the Files tab take dropped files, and the composer takes pasted files. While a file is dragged
  over them they show a 1 px `accent` outline.

## File preview

- A click on a file (a Files row, a file chip, a file link in a message, a search result) shows it over the page, as
  Quick Look does on a Mac. A click with a modifier key opens the file itself. Nothing downloads until Download.
- The web: the window less 24 px (all of it below 720 px), `surfaceRaised`, 0.5 px `borderDialog`, `radius.xl`, shadow
  `modal`, on the `overlay` backdrop. A 44 px header with a 0.5 px `border` below: the name in `fontSize.md` `medium`,
  cut with an ellipsis, the size in `fontSize.sm` `textTertiary`, then ghost icon buttons on the right: previous and
  next (when there is more than one file), Download, and Close.
- Space on a focused file opens it; Space, Escape, or the backdrop close it; ← and → show the file before or after.
- Pictures, video, and audio show centered at their size or smaller; PDFs in the browser's viewer; Markdown as prose
  in a 760 px column; code and text in the mono font with colors; CSV and spreadsheets as a table with a sticky
  header, with one tab per sheet; Word documents as their pages; slides one under the other on the background;
  zip files as a list of their files. Any other file, or one over 20 MB that the preview must read whole, shows
  "No preview" and a primary Download button.
- iOS: Quick Look, which has its own share button that saves the file.

## Artifact preview

- The Artifacts tab lists the thread's artifacts as list rows: artifact icon, title, and the number of people who
  opened it as meta. A row opens the artifact in the panel, with a close button that returns to the Artifacts list.
- The artifact has a bar (padding 4 16, 0.5 px `border` below): the title in `medium`, cut with an ellipsis, a
  badge (`accent` "Public" or plain "Members"), a small ghost "Data" button that is pressed while the data shows, and
  the actions menu (Open, Copy link, Make public or Make members only, Clear data, Delete).
- Under the bar the artifact runs and fills the panel. "Data" shows its records instead, as a settings card of compact
  rows: the key, then who (the visitor's name, "Visitor", or "Shared") and the JSON value, and a delete icon button.

## iOS

The look is measured from Linear's iOS app on an iPhone 17 Pro Max in both themes; colors and sizes are the `mobile`
tokens. The layout and navigation follow Slack's iOS app, as Golem's channels and threads are Slack's. The phone's text
was one step below the default size, so the font sizes are the measured ones × 17/16; Inter scales with Dynamic Type.
iPad keeps the sidebar with the same screens.

- Page: `background` (white, #0d0d0d dark). Text: `title` for screen titles, `text` for rows and messages,
  `textSecondary` for unselected pills and icons, `textTertiary` for captions, `textQuaternary` for section titles and
  chevrons, `placeholder` in fields. Hairlines: 1 pt `separator`, full width, only between groups.
- Tab bar: our own, not the system's, on every screen of every tab, also under a composer. A 56 pt glass capsule 20 pt
  from the screen edges and 24 pt above the bottom: Home, Golem, Activity, Search, and You, each an 18 pt icon over its
  `tabLabel` name. You opens a native menu with Settings and Workspace settings. The open one is `title` on a
  `tabSelected` capsule that slides to the tab tapped, the others `textSecondary`. Activity shows the unread count on an accent capsule. A tap on the open tab goes back to its first
  screen. The keyboard covers the bar.
- Tabs keep their own stacks and fade into each other in 200 ms. Golem, Activity, and Search open in their tabs; a
  channel or a thread opens on the open tab's stack. Settings and Workspace settings open as sheets with a close
  button.
- Home: as Slack's, with no navigation bar. The three newest open threads with their channel under the title, and
  Show more for the rest, then the channels with their count of open threads and Add channel, then the private
  channels, each with a lock, in sections whose title folds them. A 48 pt accent glass circle over the bar opens a
  native menu: New thread in a channel, or New channel.
- Screen title: top-level screens put it in the navigation bar at its leading edge, 12 pt from the screen edge, level
  with the 44 pt glass buttons at the trailing edge; `fontSize.title` `semibold`. Channels and threads show the round
  glass back button and a title capsule beside it, as Slack's: the title in `fontSize.row` `semibold` over a `caption`
  (the count of open threads, or the thread's channel). The capsule opens the screen's native menu.
- Pills: 34 high, padding 12, 7 apart, from 12 pt; the selected one is glass with `text`, the others plain
  `textSecondary`; a count in `textQuaternary` 8 pt after the title.
- Lists: rows 46 pt apart, 10 pt in from the screen with their content 10 pt further in, a 21 pt wide icon, the title in
  `fontSize.row` `book`. A row lights up on a `fill` rounded rectangle under a finger at once and fades in 150 ms. A
  folding section title is `fontSize.small` `medium` `textSecondary` 20 pt in, with a chevron that turns.
- Channel: as a Slack channel. Its open threads read as messages, the newest at the bottom over the composer: a 36 pt
  `fill` tile with an icon, the title in `fontSize.body`, then "View thread" in the accent, or the working line, and
  the time. Settled threads fold above them. Sending from the composer starts a thread.
- Conversation: as a Slack thread. Each message has the author's 36 pt avatar at the side, the name in `fontSize.row`
  `semibold` and the time in `caption` over the text; a message of the same author within five minutes shows only its
  text. Text is `fontSize.body` with inline Markdown; links take the accent. New messages slide up and fade in, and
  the newest stays in view. While Golem works, the working line sits over the composer: three accent dots that light
  in turn, "Golem is working", and Stop. The round voice button is in the bar at the trailing edge.
- Composer row: the composer 20 pt from the screen edges, 8 pt over the tab bar, or 8 pt over the keyboard while it
  shows. The composer is a glass field, radius 24: add (+), the text, the mic, and the send button once there is
  something to send. Content fades under the glass bars at the top and bottom. Dragging the content closes the
  keyboard.
- Activity: as Slack's. All and Unread pills; each notification has Golem's avatar, its title and the time, "in #"
  and the channel, two lines of text, and an accent dot while unread.
- Search: as Slack's. The field sits at the top under the title; before a query the screen lists Golem and the
  channels. Scrolling closes the keyboard.
- Artifacts: a sheet on iPhone with Artifacts and Files pills and a glass close button; an open artifact has a glass
  back button. Each screen keeps its own panel.
- Motion: springs (`snappy`) for the tab selection, folding, the panel, and new rows; native menus and pushes keep the
  system's own.
- Settings: flat groups on the page, no cards: a section title, rows 43 high with the label 20 pt in and the value at
  the right; a select is the value and an up-and-down chevron opening a native menu. Sign out is a `danger` row with
  its icon at the right. Secondary buttons are glass capsules; badges are a dot and text.
- Menus: native. Sheets: a 40 pt round glass close button at the left and the title in the middle,
  `fontSize.sheetTitle` `semibold`; fields are `fill` with radius 12 and a 1 pt accent outline when focused.

