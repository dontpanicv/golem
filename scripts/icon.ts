/**
 * Generates Golem's icon, "Dissolve, Noise", at each size where it is used: `bun scripts/icon.ts`. A cell is one device
 * pixel at every output size, so no raster is a scaled copy of another and no moiré appears.
 */
import { mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { zlibSync } from "fflate";
import tokens from "../design/tokens.json" with { type: "json" };

const ACCENT = [0xff, 0x4a, 0x1c, 0xff];
const WHITE = [0xff, 0xff, 0xff, 0xff];
const BLACK = [0, 0, 0, 0xff];
const NOTHING = [0, 0, 0, 0];

const TILE_PADDING = 0.14;
/** The face in the middle 48 dp of the 108 dp adaptive icon, inside its safe zone. */
const ADAPTIVE_PADDING = 30 / 108;

const FACE_ROWS = tokens.icon.golem.split("|");
const FOREHEAD = { left: 3, right: 5, row: 1 };

/** Each raster: the path, its size in px, the tile's padding, and the background. */
const RASTERS: readonly [string, number, number, number[]][] = [
  ["public/icon.png", 64, TILE_PADDING, BLACK],
  ["public/apple-touch-icon.png", 180, TILE_PADDING, BLACK],
  ["public/mark-1x.png", 48, TILE_PADDING, BLACK],
  ["public/mark-2x.png", 96, TILE_PADDING, BLACK],
  ["public/mark-3x.png", 144, TILE_PADDING, BLACK],
  [
    "ios/Golem/Assets.xcassets/Mark.imageset/mark-1x.png",
    48,
    TILE_PADDING,
    BLACK,
  ],
  [
    "ios/Golem/Assets.xcassets/Mark.imageset/mark-2x.png",
    96,
    TILE_PADDING,
    BLACK,
  ],
  [
    "ios/Golem/Assets.xcassets/Mark.imageset/mark-3x.png",
    144,
    TILE_PADDING,
    BLACK,
  ],
  [
    "ios/Golem/Assets.xcassets/AppIcon.appiconset/icon-1024.png",
    1024,
    TILE_PADDING,
    BLACK,
  ],
  ...(
    [
      ["mdpi", 1],
      ["hdpi", 1.5],
      ["xhdpi", 2],
      ["xxhdpi", 3],
      ["xxxhdpi", 4],
    ] as const
  ).flatMap(([density, scale]): [string, number, number, number[]][] => [
    [
      `android/app/src/main/res/mipmap-${density}/ic_launcher_foreground.png`,
      108 * scale,
      ADAPTIVE_PADDING,
      NOTHING,
    ],
    [
      `android/app/src/main/res/drawable-${density}/golem_logo.png`,
      48 * scale,
      TILE_PADDING,
      BLACK,
    ],
  ]),
];

if (import.meta.main) {
  for (const path of ["design/icon.svg", "public/icon.svg"]) {
    await Bun.write(path, svg());
  }
  for (const [path, size, padding, background] of RASTERS) {
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, png(size, cells(size, padding, background)));
  }
  await Bun.file("ios/Golem/Assets.xcassets/Mark.imageset/icon.svg")
    .exists()
    .then((exists) =>
      exists
        ? unlink("ios/Golem/Assets.xcassets/Mark.imageset/icon.svg")
        : undefined
    );
}

/** The icon at 256 cells: a black tile, one rect for each run of white, and the forehead mark. */
export function svg(): string {
  const size = 256;
  const { pad, cell } = grid(size, TILE_PADDING);
  const rects: string[] = [];
  for (let y = 0; y < size; y += 1) {
    let start = -1;
    for (let x = 0; x <= size; x += 1) {
      const white =
        x < size && colorAt(x, y, size, TILE_PADDING, BLACK) === WHITE;
      if (white && start < 0) {
        start = x;
      } else if (!white && start >= 0) {
        rects.push(
          `<rect x="${start}" y="${y}" width="${x - start}" height="1"/>`
        );
        start = -1;
      }
    }
  }
  const forehead = `<rect x="${pad + FOREHEAD.left * cell}" y="${pad + FOREHEAD.row * cell}" width="${(FOREHEAD.right - FOREHEAD.left) * cell}" height="${cell}" fill="#ff4a1c"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><title>Golem</title><rect width="${size}" height="${size}" fill="#000000"/><g fill="#ffffff">${rects.join("")}</g>${forehead}</svg>\n`;
}

/** Whether interleaved-gradient noise lights the cell at `x`, `y`; `fu` is its place across the face, from 0 to 1. */
export function lit(x: number, y: number, fu: number): boolean {
  return 1.08 - smoothstep(0.35, 1, fu) * 1.08 > noise(x, y);
}

/** The face's area: a whole number of px per cell of the 8 × 8 grid, so that each cell's edges are sharp. */
function grid(size: number, padding: number): { pad: number; cell: number } {
  const cell = Math.round(((1 - 2 * padding) * size) / 8);
  return { pad: Math.floor((size - cell * 8) / 2), cell };
}

function colorAt(
  x: number,
  y: number,
  size: number,
  padding: number,
  background: number[]
): number[] {
  const { pad, cell } = grid(size, padding);
  const column = Math.floor((x - pad) / cell);
  const row = Math.floor((y - pad) / cell);
  if (
    row === FOREHEAD.row &&
    column >= FOREHEAD.left &&
    column < FOREHEAD.right
  ) {
    return ACCENT;
  }
  if (FACE_ROWS[row]?.[column] !== "#") {
    return background;
  }
  return lit(x, y, (x + 0.5 - pad) / (cell * 8)) ? WHITE : background;
}

function cells(
  size: number,
  padding: number,
  background: number[]
): Uint8Array {
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      pixels.set(colorAt(x, y, size, padding, background), (y * size + x) * 4);
    }
  }
  return pixels;
}

function noise(x: number, y: number): number {
  return fraction(52.982_918_9 * fraction(0.067_110_56 * x + 0.005_837_15 * y));
}

function fraction(value: number): number {
  return value - Math.floor(value);
}

function smoothstep(low: number, high: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - low) / (high - low)));
  return t * t * (3 - 2 * t);
}

/** A PNG of RGBA pixels, each row with no filter. */
function png(size: number, pixels: Uint8Array): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, size);
  view.setUint32(4, size);
  header.set([8, 6, 0, 0, 0], 8);
  const raw = new Uint8Array((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw.set(
      pixels.subarray(y * size * 4, (y + 1) * size * 4),
      y * (size * 4 + 1) + 1
    );
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlibSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array()),
  ]);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const body = Buffer.concat([Buffer.from(type), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(Bun.hash.crc32(body));
  return Buffer.concat([length, body, checksum]);
}
