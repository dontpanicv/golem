# Rehearsal: golem-demo

Gold: `ai-cards`. Kept: a thread anchored at the bottom over its composer, with older turns going up out of the pane under a mask. Each answer part opens in its own `Collapse` (drop reveal for messages and cards). The cards arrive as part of the answer. The payoff holds and the poster is the finished answer.
Changed: everything visible now comes from Golem's own code. That is the canvas sidebar with the inset panel (`.panel`), Inter at weight 450, the clay accent, the pixel face (`Mark` moods), the work line (pixel spinner, shimmer, "Working for Ns · step", then "Worked for 3s" with one gold pixel for each tool call), the pixel card icons on the dark tile (`cards.tsx`), Golem's 16 px glyphs (`icon.tsx`), and the composer. For the wide hero I took the sidebar window from `linear`. The compact design is Golem's iOS thread in the kit `Phone`, with sizes from the mobile tokens, `MessageRow.swift` and `Composer.swift`. The phone is cropped at the top so the composer and its send button stay whole. The phone column gets the touch cursor.

Beats: the request is typed (the composer grows a line as the text wraps) and sent, then the message lands → Golem works ("Working for 1s · Set heating" → "2s · Get forecast" → "3s · Get car") → the work folds into "Worked for 3s ■■■" and the face smiles → the first line streams, the three cards drop in, the last line streams → payoff hold 2.6 s → the exchange fades and the earlier thread comes back down. Loop 13.4 s.

Captured: widths 960 (wide) and 390 (compact, 358 stage). Light and dark looks. `--states` at both widths. Reduced-motion posters at both widths, in both looks. Close-ups at 40–120 ms of send, work, worked (the face change), cards and exit.

Film:
- `--gate` passed on the wide loop, the 390 loop, `--states` wide and 390, dark wide and dark 390 (`/tmp/golem-demo-out/shots/final-*.png|log`).
- `loose list` (a gate line) came from the placeholder turns of mixed heights. Fixed with older turns of one height, and the gap moved inside each message. A closed message now takes no room.
- `uneven inset` (a gate line) on the phone composer's send button. Fixed with the real iOS composer padding (14 pt, `Composer.swift`) and a 10 pt inset all round.
- `settle snap` on the cards (2.9 px): a closed `Collapse` in the answer was 8 px tall because the 8 px gap was padding on the kit's inner box. The next part's opening pushed the cards 2.9 px in one frame. The gap now sits on the content, so a closed part is 0 px and opens from zero (probed every frame: first step 0.09 px).
- `jump` (+10 px at the reset): my fade replaced the kit's own `transition` on the drop content. The fade is now on the inner box, which has none.
- Standing: `settle snap` 1.1 px on the work line. This is the kit `States` hand-off: the incoming label rises 4 px (`.ss-states__item`). A per-frame probe of the work line showed no other step. `half-pixel glyph` on the face and the card icons: both are top-aligned in their boxes, not centered as the check assumes. `clipped` under the top fade mask: deliberate crop of older turns. `steps in its box` on the phone composer: its height eases by layout while text wraps (a real growing field). `handoff shift` on an `i`: the spinner pixels and the step pixels are different elements in the two crossfading labels. `appears, then moves` on the message drop: the kit's drop reveal.
- Manual: the face change at `worked`, filmed at 40 ms with `--slow 4` (`shots/b-face.png`). The working face crossfades to the done face in about 0.1 s while the labels crossfade. Nothing doubles at rest.

Review (a fresh-eye reviewer, from frames) → response:
1. The window has even gutters on three sides, so the thread is smaller than the gold's chat → kept. The film check allows a bleed off the right and bottom only. A right bleed would cut the composer's send button, which the story presses. The sidebar is Golem's identity.
2. The sidebar is empty under the channels → fixed: channel rows down past the crop.
3. The top of the poster cut "Have a safe flight." and a name row → fixed: wide stage 564 tall and a 32 px top fade, so the crop falls between messages.
4. The phone crop cut a name row → fixed: compact stage 624 tall, so the crop falls between messages.
5. The phone opening was mostly bars → partly fixed: the two nearest older turns are now short real messages ("Is the house locked?", "Yes, both doors are locked."). Three placeholder turns remain above them.
6. The "Worked for" pixels should end in red → kept. A red pixel is a failed tool call (`StepStrip`). All three calls here succeed.
7. The reset showed the old answer and the earlier thread at once → fixed: the exchange fades (0.28 s) and its room starts to close 100 ms later.
8. Polish warnings → see Film, Standing.

Assumptions: a fictional family (Mia) and fictional data. Tool step names are plausible tool words, not real connector names. The tray of older turns is placeholder. The stage ground is a light well, as in the gold; no host page was named.

Unresolved: the 1.1 px `States` hand-off and the half-pixel notes (above). Three placeholder turns stay at the top of the phone opening.

Not checked: real-time playback in a browser at speed (I judged from sheets, close-ups and the rendered MP4 frames). Touch input on a device. Pause, resume and Replay in the playground viewer. A resize between widths. A host page (the demo was filmed only on the `?capture=` route). Reduced motion while playing (only the poster). Safari and Firefox.

Render: `render.mjs` records the second loop at 2x with the stage clock and CSS animations slowed 8× (the switches `film.mjs --slow` uses). It takes the shot nearest each 30 fps frame and encodes H.264 (yuv420p, CRF 16) with ffmpeg.

Icon (2026-11-01): the Golem nav item now uses Golem's one-color pixel face, as the app does. The still check prints `mixed icons` for it beside the outline glyphs; it stays, because the product's own mark is allowed and the user chose it.

Ember (2026-11-10): the look, the logo, the 16 × 16 icons, Geist Mono values, and the words Topics and chats now follow the app. No fades or moods remain. The GIFs come from `render.mjs`, then ffmpeg with one palette for each loop.
