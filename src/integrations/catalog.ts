import type { Connector } from "./integrations.ts";
import { whatsAppConnector } from "./whatsapp.ts";

/**
 * The connectors that Golem has: ones with a secret, MCP servers that people sign in to, and WhatsApp when this machine
 * has wacli.
 */
export function integrationCatalog(
  wacli = Bun.which("wacli")
): readonly Connector[] {
  return [
    {
      id: "github",
      name: "GitHub",
      description: "Code, issues, and pull requests.",
      secretLabel: "Personal access token",
      tools: [],
    },
    {
      id: "linear",
      name: "Linear",
      description: "Issues and projects.",
      secretLabel: "API key",
      tools: [],
    },
    {
      id: "home-assistant",
      name: "Home Assistant",
      description: "The lights, devices, and sensors of the home.",
      secretLabel: "Long-lived access token",
      tools: [],
    },
    {
      id: "rohlik",
      name: "Rohlík",
      description:
        "The family's grocery shop with delivery: products, the cart, orders and their history, recipes, and shopping lists. Put things in the cart; people place the order themselves.",
      secretLabel: null,
      tools: [],
      mcp: ["https://mcp.rohlik.cz/mcp"],
    },
    {
      id: "google",
      name: "Google",
      description:
        "Gmail, Google Calendar, and Google Drive of each connected Google account. Search and read mail, and draft mail that the person sends; read calendars and events, and find free time; find, read, and create files.",
      secretLabel: null,
      tools: [],
      mcp: [
        "https://gmailmcp.googleapis.com/mcp/v1",
        "https://calendarmcp.googleapis.com/mcp/v1",
        "https://drivemcp.googleapis.com/mcp/v1",
      ],
      registered: true,
      scope: [
        "openid",
        "email",
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.compose",
        "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
        "https://www.googleapis.com/auth/calendar.events.freebusy",
        "https://www.googleapis.com/auth/calendar.events.readonly",
        "https://www.googleapis.com/auth/drive.readonly",
        "https://www.googleapis.com/auth/drive.file",
      ].join(" "),
      // A refresh token, and the choice of account, for each sign-in.
      authorizationParameters: {
        access_type: "offline",
        prompt: "consent select_account",
      },
      // The scopes above do not let these change mail labels or events.
      hiddenTools: [
        "label_message",
        "label_thread",
        "unlabel_message",
        "unlabel_thread",
        "create_event",
        "update_event",
        "delete_event",
        "respond_to_event",
      ],
    },
    {
      id: "slack",
      name: "Slack",
      description:
        "The person's Slack: search messages and files, read channels, threads, canvases, and lists, find people, and draft messages that the person sends.",
      secretLabel: null,
      tools: [],
      mcp: ["https://mcp.slack.com/mcp"],
      registered: true,
      scope: [
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
      ].join(" "),
      // `chat:write` is for drafts; agents never send.
      hiddenTools: ["slack_send_message", "slack_schedule_message"],
    },
    ...(wacli ? [whatsAppConnector(wacli)] : []),
  ];
}
