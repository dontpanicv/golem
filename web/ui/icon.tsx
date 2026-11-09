import { pixels } from "./pixels.ts";

export type IconName = keyof typeof pixels;

/** An icon on the 8 × 8 pixel grid of `icon` in design/tokens.json, 2 px a pixel. */
export function Icon({ name }: { name: IconName }) {
  return (
    <svg
      aria-hidden="true"
      className="icon"
      fill="currentColor"
      shapeRendering="crispEdges"
      viewBox="0 0 8 8"
    >
      <path d={pixels[name]} />
    </svg>
  );
}
