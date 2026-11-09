import { type TSchema, Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import type { Chats } from "../chats/chats.ts";
import type { Phone } from "./phone.ts";

const optional = Type.Optional;
const text = (description: string) => Type.String({ description });
const choice = (values: readonly string[], description: string) =>
  Type.Union(
    values.map((value) => Type.Literal(value)),
    { description }
  );
const moment = (description: string) =>
  Type.String({
    description: `${description}: ISO 8601 date and time with its UTC offset, such as 2026-11-01T09:00:00+01:00`,
  });
const id = text("The id that the phone gave");
const fileId = text("A file id of the workspace, from list_files or recall");
const priority = choice(["none", "low", "medium", "high"], "Priority");
const weekdays = Type.Array(
  choice(
    [
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
      "sunday",
    ],
    "Weekday"
  ),
  { description: "The weekdays on which it repeats; leave out for once" }
);
const contactFields = {
  given_name: optional(text("Given name")),
  family_name: optional(text("Family name")),
  organization: optional(text("Company")),
  phones: optional(
    Type.Array(
      Type.Object({
        number: text("Phone number"),
        label: optional(text("Such as mobile, home, or work")),
      })
    )
  ),
  emails: optional(
    Type.Array(
      Type.Object({
        address: text("Email address"),
        label: optional(text("Such as home or work")),
      })
    )
  ),
  birthday: optional(text("YYYY-MM-DD, or --MM-DD without a year")),
};
const healthMetrics = [
  "steps",
  "distance",
  "active_energy",
  "flights",
  "exercise_minutes",
  "heart_rate",
  "resting_heart_rate",
  "heart_rate_variability",
  "respiratory_rate",
  "oxygen_saturation",
  "weight",
  "body_fat",
  "water",
  "caffeine",
  "mindful_minutes",
  "sleep",
  "workouts",
];
const healthLogMetrics = [
  "water",
  "caffeine",
  "weight",
  "body_fat",
  "mindful_minutes",
];
const homeName = optional(text("The home, when the person has several"));

interface PhoneTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, TSchema>;
  /** It only reads, so a rerun after a restart does no harm. */
  readonly reads?: boolean;
}

/** Every tool of the phone. The app runs each one with Apple's own frameworks; `ios/Golem/Phone/` has one file each. */
const TOOLS: readonly PhoneTool[] = [
  {
    name: "alarm_set",
    description:
      "Set an alarm that rings like a Clock alarm, also in silent mode. Give `time` for the next such time or for the weekdays in `weekdays`, or `at` for one date.",
    parameters: {
      label: text("What the alarm is for"),
      time: optional(text("Local time HH:MM")),
      weekdays: optional(weekdays),
      at: optional(moment("One date and time")),
    },
  },
  {
    name: "timer_start",
    description:
      "Start a countdown timer, which shows on the Lock Screen and in the Dynamic Island and rings at its end.",
    parameters: {
      label: text("What the timer is for"),
      seconds: Type.Integer({ minimum: 1, maximum: 86_400 }),
    },
  },
  {
    name: "alarms",
    description:
      "List the alarms and timers that Golem set on the phone, with their ids and states. Alarms of the Clock app are not visible.",
    parameters: {},
    reads: true,
  },
  {
    name: "alarm_change",
    description:
      "Cancel an alarm or a timer, stop one that rings, or pause or resume a timer.",
    parameters: {
      id,
      action: choice(["cancel", "stop", "pause", "resume"], "What to do"),
    },
  },
  {
    name: "reminder_lists",
    description: "List the lists of Apple Reminders.",
    parameters: {},
    reads: true,
  },
  {
    name: "reminders",
    description:
      "List the items of Apple Reminders: the open ones, or the completed ones.",
    parameters: {
      list: optional(text("A list name; leave out for all lists")),
      completed: optional(Type.Boolean({ description: "Default false" })),
      limit: optional(Type.Integer({ minimum: 1, maximum: 500 })),
    },
    reads: true,
  },
  {
    name: "reminder_add",
    description:
      "Add an item to Apple Reminders, such as to a shopping list. For a reminder that Golem itself sends, use reminders_create.",
    parameters: {
      title: text("The item"),
      list: optional(text("A list name; default the person's default list")),
      due: optional(moment("When it is due; the phone alerts then")),
      notes: optional(text("Notes")),
      priority: optional(priority),
    },
  },
  {
    name: "reminder_change",
    description:
      "Change an item of Apple Reminders, or mark it completed or open again.",
    parameters: {
      id,
      title: optional(text("The item")),
      due: optional(moment("When it is due")),
      notes: optional(text("Notes")),
      priority: optional(priority),
      completed: optional(Type.Boolean()),
    },
  },
  {
    name: "reminder_delete",
    description: "Delete an item of Apple Reminders.",
    parameters: { id },
  },
  {
    name: "calendars",
    description:
      "List the calendars on the phone (iCloud, Google, Exchange, and others), and which ones can change.",
    parameters: {},
    reads: true,
  },
  {
    name: "events",
    description: "List the calendar events between two times.",
    parameters: {
      from: moment("Start"),
      to: moment("End"),
      calendar: optional(text("A calendar name; leave out for all")),
    },
    reads: true,
  },
  {
    name: "event_add",
    description:
      "Add a calendar event. It cannot invite people; the phone's calendars cannot.",
    parameters: {
      title: text("Title"),
      start: moment("Start"),
      end: moment("End"),
      all_day: optional(Type.Boolean()),
      calendar: optional(text("A calendar name; default the default calendar")),
      location: optional(text("Place or address")),
      notes: optional(text("Notes")),
      alert_minutes: optional(
        Type.Integer({
          minimum: 0,
          description: "Alert this many minutes before",
        })
      ),
    },
  },
  {
    name: "event_change",
    description:
      "Change a calendar event; for a repeating event, only this one occurrence.",
    parameters: {
      id,
      title: optional(text("Title")),
      start: optional(moment("Start")),
      end: optional(moment("End")),
      all_day: optional(Type.Boolean()),
      location: optional(text("Place or address")),
      notes: optional(text("Notes")),
    },
  },
  {
    name: "event_delete",
    description:
      "Delete a calendar event; for a repeating event, only this one occurrence.",
    parameters: { id },
  },
  {
    name: "contacts",
    description:
      "Find contacts by name, with their numbers, emails, addresses, company, and birthday.",
    parameters: { query: text("A name or part of one") },
    reads: true,
  },
  {
    name: "contact_add",
    description: "Add a contact.",
    parameters: contactFields,
  },
  {
    name: "contact_change",
    description:
      "Change a contact: it replaces the names, company, and birthday that you give, and adds the phones and emails.",
    parameters: { id, ...contactFields },
  },
  {
    name: "message",
    description:
      "Open an iMessage or SMS with the recipients and text filled in; the person taps Send. Answers whether they sent it.",
    parameters: {
      recipients: Type.Array(text("Phone number or email")),
      body: text("The message"),
    },
  },
  {
    name: "mail",
    description:
      "Open an email with the recipients, subject, and text filled in, from the phone's Mail accounts; the person taps Send.",
    parameters: {
      to: Type.Array(text("Email address")),
      cc: optional(Type.Array(text("Email address"))),
      subject: text("Subject"),
      body: text("Plain text"),
    },
  },
  {
    name: "call",
    description:
      "Start a phone call or a FaceTime call; iOS asks the person before it dials.",
    parameters: {
      to: text("Phone number, or an email for FaceTime"),
      kind: optional(
        choice(["phone", "facetime", "facetime_audio"], "Default phone")
      ),
    },
  },
  {
    name: "music_play",
    description: "Find music in Apple Music and play it in the Music app.",
    parameters: {
      query: text("What to find, such as an artist, a song, or a playlist"),
      kind: optional(
        choice(
          ["song", "album", "playlist", "artist"],
          "What to play; default song. For an artist, their top songs"
        )
      ),
    },
  },
  {
    name: "music_control",
    description: "Control the Music app, or with `status` say what plays now.",
    parameters: {
      action: choice(
        ["play", "pause", "next", "previous", "status"],
        "What to do"
      ),
    },
  },
  {
    name: "photos",
    description:
      "Find photos and videos in the photo library by date, kind, or favorite, newest first, with their ids, dates, and places. phone_photo shows one.",
    parameters: {
      from: optional(moment("Taken at or after")),
      to: optional(moment("Taken before")),
      kind: optional(
        choice(["photo", "video", "screenshot", "live"], "Only this kind")
      ),
      favorites: optional(Type.Boolean()),
      limit: optional(Type.Integer({ minimum: 1, maximum: 100 })),
    },
    reads: true,
  },
  {
    name: "photo",
    description: "Look at one photo of the library, or a video's first frame.",
    parameters: { id },
    reads: true,
  },
  {
    name: "photo_save",
    description:
      "Save a picture or video file of the workspace to the photo library.",
    parameters: { file_id: fileId },
  },
  {
    name: "camera",
    description:
      "Open the camera, which the person uses to take a photo or to scan a document, and look at the result.",
    parameters: {
      mode: optional(
        choice(["photo", "document"], "Default photo; document scans pages")
      ),
    },
  },
  {
    name: "health",
    description:
      "Read Apple Health between two times: daily totals or averages, sleep per night, or the workouts.",
    parameters: {
      metric: choice(healthMetrics, "What to read"),
      from: moment("Start"),
      to: moment("End"),
    },
    reads: true,
  },
  {
    name: "health_log",
    description:
      "Write a value to Apple Health: water in ml, caffeine in mg, weight in kg, body fat in percent, or mindful minutes.",
    parameters: {
      metric: choice(healthLogMetrics, "What to write"),
      value: Type.Number(),
      at: optional(moment("When; default now")),
    },
  },
  {
    name: "location",
    description:
      "Where the phone is now: its coordinates, accuracy, and address.",
    parameters: {},
    reads: true,
  },
  {
    name: "directions",
    description: "Open directions in Apple Maps.",
    parameters: {
      destination: text("An address, a place name, or latitude,longitude"),
      mode: optional(
        choice(["driving", "walking", "transit", "cycling"], "Default driving")
      ),
    },
  },
  {
    name: "open",
    description:
      "Open a link on the phone: a web page, or a link that an app opens, such as a maps, tel, or app link.",
    parameters: { url: text("The URL") },
  },
  {
    name: "clipboard",
    description:
      "Copy `text` to the phone's clipboard, or without `text` read the clipboard; iOS may ask the person to allow the paste.",
    parameters: { text: optional(text("The text to copy")) },
  },
  {
    name: "device",
    description:
      "The phone's battery, charging, Low Power Mode, model, iOS version, free storage, and screen brightness.",
    parameters: {},
    reads: true,
  },
  {
    name: "flashlight",
    description: "Turn the flashlight on or off.",
    parameters: {
      on: Type.Boolean(),
      level: optional(
        Type.Number({ minimum: 0.1, maximum: 1, description: "Default 1" })
      ),
    },
  },
  {
    name: "brightness",
    description: "Set the screen brightness while the Golem app is open.",
    parameters: { level: Type.Number({ minimum: 0, maximum: 1 }) },
  },
  {
    name: "home",
    description:
      "List the Apple Home homes, rooms, accessories with their power, and scenes.",
    parameters: {},
    reads: true,
  },
  {
    name: "home_scene",
    description: "Run an Apple Home scene.",
    parameters: { name: text("The scene"), home: homeName },
  },
  {
    name: "home_power",
    description:
      "Turn an Apple Home accessory, such as a light or a plug, on or off.",
    parameters: {
      accessory: text("The accessory, or room and accessory"),
      on: Type.Boolean(),
      home: homeName,
    },
  },
  {
    name: "wallet_add",
    description:
      "Add a pass file (.pkpass) of the workspace, such as a ticket or a boarding pass, to Apple Wallet; the person confirms.",
    parameters: { file_id: fileId },
  },
];

/** The tools that run on the iPhone of a turn's person, while the Golem app is open on it. */
export function phoneTools(
  phone: Phone,
  chats: Pick<Chats, "requester">,
  workspaceId: string
) {
  return TOOLS.map((tool) =>
    defineTool({
      name: `phone_${tool.name}`,
      description: tool.description,
      parameters: Type.Object(tool.parameters),
      replay: tool.reads ? "safe" : "unsafe",
      execute: async (args, api, context) => {
        const person = await chats.requester(workspaceId, api.conversationId);
        if (!person) {
          throw new Error(
            "Phone tools act only on the phone of the person who asked in this turn."
          );
        }
        const reply = await phone.call(
          person.id,
          workspaceId,
          tool.name,
          args as Record<string, unknown>,
          context.abortSignal
        );
        const images = await Promise.all(
          reply.images.map(async (image) => ({
            type: "image" as const,
            data: Buffer.from(await image.arrayBuffer()).toString("base64"),
            mimeType: "image/jpeg",
          }))
        );
        return {
          output: [{ type: "text" as const, text: reply.text }, ...images],
        };
      },
    })
  );
}
