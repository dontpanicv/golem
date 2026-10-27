import { googleConnector } from "./google.ts";
import { homeAssistantConnector } from "./home-assistant.ts";
import { instagramConnector } from "./instagram.ts";
import type { Connector } from "./integrations.ts";
import { PASTE_ADDRESS, SIGN_IN_ADDRESS } from "./sign-in.ts";
import { whatsAppConnector } from "./whatsapp.ts";
import { xConnector } from "./x.ts";

/** What Slack's sign-in asks for: reading, and `chat:write` for drafts. */
const SLACK_SCOPES = [
  "search:read.public",
  "search:read.private",
  "search:read.mpim",
  "search:read.im",
  "search:read.files",
  "search:read.users",
  "channels:history",
  "groups:history",
  "mpim:history",
  "im:history",
  "channels:read",
  "groups:read",
  "mpim:read",
  "im:read",
  "users:read",
  "users:read.email",
  "files:read",
  "canvases:read",
  "lists:read",
  "reactions:read",
  "emoji:read",
  "chat:write",
];

/**
 * The connectors that Golem has: ones with a secret, MCP servers that people sign in to, Google when this machine has
 * gog, and WhatsApp when it has wacli.
 */
export function integrationCatalog(
  wacli = Bun.which("wacli"),
  gog = Bun.which("gog")
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
    ...(gog ? [googleConnector(gog)] : []),
    {
      id: "slack",
      name: "Slack",
      description:
        "The person's Slack: search messages and files, read channels, threads, canvases, and lists, find people, and draft messages that the person sends.",
      secretLabel: null,
      tools: [],
      mcp: ["https://mcp.slack.com/mcp"],
      registered: true,
      scope: SLACK_SCOPES.join(" "),
      guide: [
        "On [api.slack.com/apps](https://api.slack.com/apps), click **Create New App › From scratch**, and select the Slack workspace.",
        `In **OAuth & Permissions**, add the redirect URL \`${SIGN_IN_ADDRESS}\`, and these **User Token Scopes**: ${SLACK_SCOPES.map((scope) => `\`${scope}\``).join(", ")}.`,
        "In **Agents & AI Apps**, turn on **Model Context Protocol**.",
        "Install the app to the Slack workspace. An administrator may need to approve it.",
        "Click **Client** here, and paste the **Client ID** and **Client Secret** from **Basic Information**.",
        "Click **Connect**, and sign in to Slack.",
        PASTE_ADDRESS,
      ],
      // `chat:write` is for drafts; agents never send.
      hiddenTools: ["slack_send_message", "slack_schedule_message"],
    },
    xConnector(),
    instagramConnector(),
    ...(wacli ? [whatsAppConnector(wacli)] : []),
  ];
}
