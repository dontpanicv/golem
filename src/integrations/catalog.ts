import { googleConnector } from "./google.ts";
import { homeAssistantConnector } from "./home-assistant.ts";
import { instagramConnector } from "./instagram.ts";
import type { Connector } from "./integrations.ts";
import { PASTE_ADDRESS } from "./sign-in.ts";
import { slackConnector } from "./slack.ts";
import { whatsAppConnector } from "./whatsapp.ts";
import { xConnector } from "./x.ts";

/**
 * The connectors that Golem has: ones with a secret, MCP servers that people sign in to, Google when this machine has
 * gog, Slack when it has slackcli, and WhatsApp when it has wacli.
 */
export function integrationCatalog(
  wacli = Bun.which("wacli"),
  gog = Bun.which("gog"),
  slackcli = Bun.which("slackcli")
): readonly Connector[] {
  return [
    homeAssistantConnector(),
    {
      id: "rohlik",
      name: "Rohlík",
      description:
        "The family's grocery shop with delivery: products, the cart, orders and their history, recipes, and shopping lists. Put things in the cart; people place the order themselves.",
      secretLabel: null,
      guide: ["Click **Connect**, and sign in to Rohlík.", PASTE_ADDRESS],
      tools: [],
      mcp: ["https://mcp.rohlik.cz/mcp"],
    },
    {
      id: "plaud",
      name: "Plaud",
      description:
        "The person's Plaud recordings: find them, and read their transcripts with speakers and times, summaries, and action items.",
      secretLabel: null,
      guide: ["Click **Connect**, and sign in to Plaud.", PASTE_ADDRESS],
      tools: [],
      mcp: ["https://mcp.plaud.ai/mcp"],
      // Golem keeps the sign-in; an agent must not revoke it.
      hiddenTools: ["login", "logout"],
    },
    ...(gog ? [googleConnector(gog)] : []),
    ...(slackcli ? [slackConnector(slackcli)] : []),
    xConnector(),
    instagramConnector(),
    ...(wacli ? [whatsAppConnector(wacli)] : []),
  ];
}
