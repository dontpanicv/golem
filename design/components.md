# Golem components

Measurements come from Linear's interface and live in `tokens.json`. Every component exists on the web
(`public/styles.css`, `public/ui.js`, `src/platform/ui/`) and on iOS (`ios/Golem/Design/`) with the same look and
behavior.
Native selects and pickers are never used: menus, selects, switches, and checkboxes are our own.

Motion: color and border changes take `duration.fast` (150 ms) ease-out. Popovers and dialogs open in
`duration.menu` (140 ms) with `easing.out`, from opacity 0 and scale 0.96 (dialogs 0.98) toward the trigger, and close
in 100 ms. Respect reduced motion: no scaling, fades only.

## Buttons

| Variant | Look | Hover / pressed |
| --- | --- | --- |
| primary | `accent` fill, `onAccent` text, shadow `low` | `accentHover` |
| secondary | `surfaceRaised` fill, 0.5 px `borderStrong` ring | `surfaceHover` |
| ghost | transparent | `fillHover` on the canvas, `surfaceHover` on surfaces |
| danger | secondary with `danger` text | secondary hover |

- Text buttons are pills (`radius.full`), `size.control` (32) high, 12 px side padding, `fontSize.md` `medium`.
- `small`: `size.controlSmall` (28), `radius.md` (8): toolbars and headers.
- `icon`: square, `size.controlSmall` (28) or `size.controlTiny` (24), `radius.md`, a 16 px icon.
- `large`: `size.controlLarge` (40), full width: sign-in and dialogs on phones.
- Disabled: 50 % opacity, no hover.
- Focus: 1 px `accent` outline, offset 1 px.
- iOS keeps the visual height and extends the touch target to 44 pt.

## Text field

- `size.control` (32) high, `radius.md`, padding 6 × 12, `surfaceRaised` fill, 0.5 px `borderStrong`, `fontSize.md`.
- Placeholder `textQuaternary`. Focus: 1 px `accent` outline at offset −1 px (iOS: a 1 pt `accent` border).
- Label above: `fontSize.sm` `medium` `textTertiary`, 4 px gap. Errors use a toast, not inline text.
- Large variant (sign-in): `size.controlLarge` (40).

## Select

A trigger that opens a menu of options; never a native select.

- Trigger: `size.control` − 2 (30) high, `radius.md`, padding 1 × 28 × 1 × 10, `surfaceRaised`, 0.5 px transparent border,
  value in `fontSize.md` `regular`, chevron 16 px at the right. Hover: `surfaceHover`.
- Opens the menu below the trigger, right-aligned, or above when there is no room.
- Keyboard: Enter, Space, or ↓ opens; ↑ ↓ Home End move; Enter selects; Escape closes; typing jumps to a match.
- Selecting closes the menu and updates the value. `autosubmit` submits the surrounding form at once.

## Menu

Used by selects, the workspace switcher, and action menus.

- `surfaceRaised`, `radius.xl` (12), padding 4 × 0, min width `size.menuMinWidth`.
- Shadow: a 0.5 px `borderStrong` ring plus shadow `menu`.
- Item: `size.menuItem` (32) high, padding 0 × 35 × 0 × 12, `fontSize.md`, `textSecondary`.
  The highlight is inset 4 px left and right, `radius.md`, `surfaceHover`.
  A selected option shows a 16 px check at the right.
- Optional leading icon (16 px, `textTertiary`) and trailing shortcut (`kbd`).
- Separator: 0.5 px `border`, 4 px vertical margin. Section label: `fontSize.xs` `medium` `textTertiary`, 28 high.

## Switch

- Track `size.switchWidth` × `size.switchHeight` (30 × 20), `radius.full`. Off: `switchTrack`. On: `accent`.
- Knob `size.switchKnob` (14), `onAccent`, 3 px from the edge; it travels 10 px.
- The knob's leading and trailing edges move `duration.knob` (100 ms) ease-out, the trailing edge 50 ms later,
  so the knob stretches while it moves. While pressed, the knob widens by 4 px.
- The track color changes in 150 ms. The touch target is 42 × 32 on the web and 44 pt on iOS.
- `autosubmit` submits the form on change.

## Checkbox

- `size.checkbox` (14) square, `radius.xs` (4), 1 px `borderStrong`, `surfaceRaised`.
- Checked: `accent` fill and border with a white 10 px check that draws in 150 ms.
- Label to the right, `fontSize.md` `textSecondary`, 8 px gap; the whole row toggles.

## Tooltip

- Shows after 500 ms of hover or keyboard focus; hides at once on leave. Once one is shown, the next appears
  without delay for 300 ms.
- `size.tooltip` (28) high, padding 0 × 8, `radius.md`, `surfaceRaised`, 0.5 px `border`, shadow `low`.
  Text `fontSize.xs` `book` `textSecondary`, with an optional shortcut `kbd`.
- Placed 6 px below the target, centered, or above when there is no room. Fades in 100 ms.
- iOS has no hover: icon buttons carry accessibility labels instead.

## Dialog

- `overlay` backdrop. Card `surfaceRaised`, `radius.xl`, menu shadow and ring, width min(440, 100 % − 32).
- Header: title `fontSize.lg` `semibold`, close icon button. Body: 16 px padding, fields stacked 12 px apart.
- Footer: buttons right-aligned, secondary then primary. Escape and the backdrop close it.
- iOS: a sheet with the same card styling at medium detent.

## Toast

- Bottom center (web) or top (iOS), 12 px from the edge. Card like a menu, padding 8 × 12, `fontSize.md`.
- Variants: neutral, success (`success` dot), and error (`danger` dot). Slides 8 px and fades in 140 ms;
  disappears after 5 s or on click.

## Settings card

- `surfaceRaised`, `radius.lg` (10), ring 0.5 px `border` and shadow `low`.
- Row: min `size.settingsRow` (60) high, padding 16, label `fontSize.md` `medium` `text`, description
  `fontSize.sm` `book` `textTertiary`, control at the right. Rows are separated by 0.5 px `borderSubtle`.
- Section title above the card: `fontSize.lg` `medium` `text`, 12 px gap. Page title: `fontSize.xxl` `medium`.

## Badge and keycap

- Badge: 20 high, `radius.full`, 0.5 px `border`, `fontSize.xs` `medium`, a 6 px dot in the tone color.
- Keycap (`kbd`): min 18 × 18, `radius.xs`, 0.5 px `borderStrong`, `fontSize.xs`, `textTertiary`.
