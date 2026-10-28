# Integrations

People connect integrations in Settings: in their own Settings for their own turns, or in Workspace settings for the
turns of every member. A person can connect more than one account of an integration, such as a work and a personal
Google account. Agents name the account with the `account` argument of each tool, and `<integration>_accounts` lists
the accounts. Agents only draft: they do not send mail or messages.

Settings shows the steps that set up each integration: click ⓘ on it. The steps are the `guide` of its connector, in
`src/integrations/`.

Google and Slack need an OAuth client of your own, which the server's owner (the first of `allowed_emails`) sets with
**Client** on the integration; the next sign-in uses it at once. Until then, only the owner sees them. Google also needs
`gog` on the Golem machine, and WhatsApp `wacli`, in the `PATH` of the Golem service; install them, for example with
`brew install gogcli` and `brew install openclaw/tap/wacli`, and click **Reload** on Configuration in Settings. Golem
does not show these integrations without them.

The sign-in pages of Google, Slack, and Rohlík end at `https://localhost/golem-sign-in?code=…`. Nothing answers at that
address, so the browser shows an error page. Copy the address from the address bar and paste it into Golem.

## Google: Gmail, Calendar, and Drive

Golem calls Google's APIs through [gog](https://github.com/openclaw/gogcli), with the access token of each sign-in,
which Golem renews with its refresh token. One client serves all accounts: personal and Google Workspace ones, of every
person. Google shows that it has not verified the app; an app that is not verified can have up to 100 users.

Agents search and read mail, and make drafts that you send from Gmail, with files of the workspace attached; gog blocks
sending. Agents use only these tools for mail, never a mail app on a machine. They read calendars, find free time, and create, change, and delete events; guests get no email about it, so send updates from Google Calendar.
They search Drive, read Docs and Sheets, create Docs, and change only the Docs that they created. They upload files of
the workspace to Drive and share the files that they uploaded or created, with anyone who has the link, a person, or a
domain; Google sends no invitation email.

## Slack

Golem uses Slack's MCP server, which needs a Slack app in your Slack workspace. Agents search and read messages,
files, canvases, and lists, and make drafts. They do not get Slack's tools that send or schedule messages;
`chat:write` is for the drafts.

## WhatsApp

Golem links your number as a device, as WhatsApp Web does, through [wacli](https://github.com/openclaw/wacli). This is
not WhatsApp's own API, and WhatsApp can ban a number that uses it.

Your phone sends Golem the newest messages of each chat, often only some days, and Golem keeps a copy of every new
message while it runs. The copy and the device's keys are in `data/integrations/<credential-id>/`. Agents read chats and
messages, search them, and find contacts. For older messages, ask an agent to load them: it asks your phone, which must
be online, for up to 5000 older messages of a chat at a time. For a message, they make a `wa.me` link that opens
WhatsApp with the text; you send it. Deleting the credential removes the device from your number.

## X

Golem reads your X account through [Rettiwt-API](https://github.com/Rishikant181/Rettiwt-API), with a key made from the
cookies of your X session. This is not X's paid API, and X can limit or ban an account that uses it. The key gives the
same access as your login, so keep it secret, as Golem does. It works for about five years, or until you sign out of
that session or change your password.

Agents read your bookmarks, newest first, and posts with their replies and threads. They do not post, like, or change
bookmarks.

## Instagram

Golem reads your Instagram account through Instagram's own web API, with the `sessionid` cookie of your Instagram
session. Instagram has no API for saved posts, and it can lock or ban an account that uses this one. The cookie gives
the same access as your login, so keep it secret, as Golem does. Golem also sends the `ds_user_id` cookie, which
Instagram needs; it is the number at the start of `sessionid`.

Agents read all the posts and reels that you saved, newest first, with the ids of their collections, and the posts of
one collection: the caption, the author, the place, and the pictures and videos. Instagram's web API gives no list of
collections with their names. Agents do not save, like, or post. Instagram watches for many calls: read a large
backlog in small steps.

## Home Assistant

Golem controls your home through the REST API of Home Assistant, with a long-lived access token of a Home Assistant
user. The user must be an administrator, because Home Assistant renders templates only for administrators.

Agents read the states and history of entities, render templates, for example to find the entities of an area, and
call services, such as turning on a light or setting a thermostat. They do not call `notify` services.
