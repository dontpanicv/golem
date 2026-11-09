/**
 * The 1 px, 8 × 8 Bayer dither. `installDither` paints each pattern once as a one-color mask and gives it to the
 * stylesheet as a `--dither-*` variable; the stylesheet colors it, so the patterns serve both themes. iOS and Android
 * make the same patterns in `Dither`.
 */

/** Golem's face in `design/tokens.json`, which the empty states show. */
const FACE = [
  "########",
  "###..###",
  "#..##..#",
  "########",
  "########",
  "##....##",
  "########",
  ".######.",
];

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
  set(
    "fade-top",
    mask(8, 28, (_u, v) => v)
  );
  set(
    "fade-bottom",
    mask(8, 56, (_u, v) => 1 - v)
  );
  set(
    "header",
    mask(8, 16, (_u, v) => (1 - v) ** 1.6 * 0.42)
  );
  set("empty", mask(96, 96, emptyFace));
  for (const size of AVATAR_SIZES) {
    set(`corner-${size}`, mask(size, size, avatarCorner));
  }
}

function emptyFace(u: number, v: number): number {
  const row = FACE[Math.floor(v * 8)] ?? "";
  return row[Math.floor(u * 8)] === "#" ? 0.1 + 0.75 * (1 - v) : 0;
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
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d")!;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (value((x + 0.5) / width, (y + 0.5) / height) > threshold(x, y)) {
        context.fillRect(x, y, 1, 1);
      }
    }
  }
  return canvas.toDataURL();
}
