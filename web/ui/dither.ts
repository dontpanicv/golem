/**
 * The 0.5 px, 8 × 8 Bayer dither. `installDither` paints each pattern once as a one-color mask and gives it to the
 * stylesheet as a `--dither-*` variable; the stylesheet colors it, so the patterns serve both themes. iOS and Android
 * make the same patterns in `Dither`.
 */

/** The sizes of an avatar tile in px: `small`, the default, and `large`. */
const AVATAR_SIZES = [20, 24, 48];

/** The ranks of the 8 × 8 Bayer matrix. */
const BAYER = [
  [0, 32, 8, 40, 2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21],
];

export function installDither(): void {
  const { style } = document.documentElement;
  const set = (name: string, url: string) =>
    style.setProperty(`--dither-${name}`, `url("${url}")`);
  set(
    "selected",
    mask(48, 8, (u) => u ** 1.25)
  );
  for (const size of AVATAR_SIZES) {
    set(`corner-${size}`, mask(size, size, avatarCorner));
  }
}

/** Lit toward the bottom right corner. */
function avatarCorner(u: number, v: number): number {
  return ((u + v) / 2 - 0.48) * 2;
}

/** A cell's threshold, from 0 to 1 and never exactly either. */
function threshold(x: number, y: number): number {
  return (BAYER[y % 8]![x % 8]! + 0.5) / 64;
}

function mask(
  width: number,
  height: number,
  value: (u: number, v: number) => number
): string {
  const columns = width * 2;
  const rows = height * 2;
  const canvas = document.createElement("canvas");
  canvas.width = columns;
  canvas.height = rows;
  const context = canvas.getContext("2d")!;
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < columns; x += 1) {
      if (value((x + 0.5) / columns, (y + 0.5) / rows) > threshold(x, y)) {
        context.fillRect(x, y, 1, 1);
      }
    }
  }
  return canvas.toDataURL();
}
