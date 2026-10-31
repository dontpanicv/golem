/**
 * A card that an agent writes in an answer, for a value that matters: a fenced `card` block with one JSON object, or a
 * list of them. iOS: `MarkdownText.Card`.
 *
 * @example
 * ```card
 * [{"icon": "heat", "title": "Living room", "value": "17.2 → 22 °C", "detail": "from 18:30"}]
 * ```
 */
export interface Card {
  readonly value: string;
  readonly title?: string;
  readonly detail?: string;
  readonly icon?: string;
}

/** The pixel icons of cards, in the cells of an 8 × 8 grid. iOS has the same in `PixelIcon`. */
const ICONS: Record<string, string> = {
  temperature: "M3 0H5V5H6V7H5V8H3V7H2V5H3Z",
  heat: "M4 0H5V1H6V3H7V6H6V7H5V8H3V7H2V6H1V3H2V2H3V1H4Z",
  rain: "M2 1H5V2H6V3H7V5H1V4H0V3H1V2H2ZM1 6H2V7H1ZM3 6H4V8H3ZM5 6H6V7H5Z",
  sun: "M3 2H5V3H6V5H5V6H3V5H2V3H3ZM3 0H5V1H3ZM3 7H5V8H3ZM0 3H1V5H0ZM7 3H8V5H7Z",
  battery: "M0 2H7V3H8V5H7V6H0ZM1 3V5H4V3Z",
  bolt: "M4 0H6V1H5V3H7V4H6V5H5V6H4V7H3V8H2V5H1V4H3V2H4Z",
  car: "M2 1H6V2H7V4H8V6H7V7H5V6H3V7H1V6H0V4H1V2H2ZM2 2V4H6V2Z",
  home: "M3 0H5V1H6V2H7V3H8V4H7V8H5V5H3V8H1V4H0V3H1V2H2V1H3Z",
  lock: "M2 0H6V1H7V3H8V8H0V3H1V1H2ZM2 1V3H6V1ZM3 4V6H5V4Z",
};

/** The cards of a `card` block, or null when it is not valid, so that it shows as code. */
export function parseCards(json: string): Card[] | null {
  try {
    const value: unknown = JSON.parse(json);
    const cards = Array.isArray(value) ? value : [value];
    return cards.length > 0 && cards.every(isCard) ? cards : null;
  } catch {
    return null;
  }
}

function isCard(value: unknown): value is Card {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const card = value as Record<string, unknown>;
  return (
    typeof card.value === "string" &&
    ["title", "detail", "icon"].every(
      (key) => card[key] === undefined || typeof card[key] === "string"
    )
  );
}

export function Cards({ cards }: { cards: readonly Card[] }) {
  return (
    <div className="cards">
      {cards.map((card, index) => {
        const icon = card.icon ? ICONS[card.icon] : undefined;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: the cards of an answer never change order
          <div className="card" key={index}>
            {icon ? (
              <svg
                aria-hidden="true"
                className="card-icon"
                shapeRendering="crispEdges"
                viewBox="-2 -2 12 12"
              >
                <path d={icon} fillRule="evenodd" />
              </svg>
            ) : null}
            <div className="card-text">
              {card.title ? (
                <span className="card-title">{card.title}</span>
              ) : null}
              <strong className="card-value">{card.value}</strong>
              {card.detail ? (
                <span className="card-detail">{card.detail}</span>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
