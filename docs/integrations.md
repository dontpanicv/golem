# Integrations

People connect integrations in Settings: in their own Settings for their own turns, or in Workspace settings for the
turns of every member. A person can connect more than one account of an integration, such as a work and a personal
Google account. Agents name the account with the `account` argument of each tool, and `<integration>_accounts` lists
the accounts. Agents only draft: they do not send mail or messages.

Google and Slack need an OAuth client of your own in `config/golem.toml`, and WhatsApp needs `wacli` on the Golem
machine. Golem does not show an integration that does not have them. Do these steps one time for each Golem server.

## Sign-in address

The sign-in pages of Google, Slack, and Rohlík end at `https://localhost/golem-sign-in?code=…`. Nothing answers at that
address, so the browser shows an error page. Copy the address from the address bar and paste it into Golem.

## Google: Gmail, Calendar, and Drive

Golem uses Google's MCP servers for Gmail, Calendar, and Drive. They are in the Google Workspace Developer Preview
Program, so your Google Cloud project must be a member.

1. Open the [Google Cloud console](https://console.cloud.google.com) and select your project.
2. In **APIs & Services › Library**, enable the Gmail API, the Google Calendar API, and the Google Drive API, and
   their MCP servers (search for `MCP`).
3. Open **Google Auth Platform**:
   - **Audience**: **External**, so that work and personal accounts can both sign in. Set the publishing status to
     **In production**. In **Testing**, Google ends each sign-in after 7 days.
   - **Data access**: add these scopes: `openid`, `email`, `gmail.readonly`, `gmail.compose`,
     `calendar.calendarlist.readonly`, `calendar.events.freebusy`, `calendar.events.readonly`, `drive.readonly`, and
     `drive.file`.
   - **Clients › Create client**: select **Web application**, and select **Use this client for an AI-powered agent**.
     Add the authorized redirect URI `https://localhost/golem-sign-in`. Do not use the client of Google sign-in.
4. Add the client to `config/golem.toml`, and click **Reload** on Configuration in Settings:

   ```toml
   [integrations.google]
   client_id = "…apps.googleusercontent.com"
   client_secret = "…"
   ```

5. In Settings, click **Connect** on Google, sign in, and select the account. Google tells you that it has not
   verified the app: click **Advanced**, then continue. Paste the address where the sign-in ends. Do this again for
   each account.

If a Google Workspace account cannot sign in, its administrator must trust the client in the Admin console, in
**Security › Access and data control › API controls**.

Agents read mail and make drafts that you send from Gmail. They read calendars and find free time, and they find,
read, and create files in Drive.

## Slack

Golem uses Slack's MCP server, which needs a Slack app in your Slack workspace.

1. On [api.slack.com/apps](https://api.slack.com/apps), click **Create New App › From scratch**, and select your
   Slack workspace.
2. In **OAuth & Permissions**, add the redirect URL `https://localhost/golem-sign-in`, and add these **User Token
   Scopes**: `search:read.public`, `search:read.private`, `search:read.mpim`, `search:read.im`, `search:read.files`,
   `search:read.users`, `channels:history`, `groups:history`, `mpim:history`, `im:history`, `channels:read`,
   `groups:read`, `mpim:read`, `im:read`, `users:read`, `users:read.email`, `files:read`, `canvases:read`,
   `lists:read`, `reactions:read`, `emoji:read`, and `chat:write`.
3. In **Agents & AI Apps**, turn on **Model Context Protocol**.
4. Install the app to the Slack workspace. An administrator may need to approve it.
5. Copy the **Client ID** and **Client Secret** from **Basic Information** to `config/golem.toml`, and click **Reload** on Configuration in Settings:

   ```toml
   [integrations.slack]
   client_id = "…"
   client_secret = "…"
   ```

6. In Settings, click **Connect** on Slack, sign in, and paste the address where the sign-in ends.

Agents search and read messages, files, canvases, and lists, and make drafts. They do not get Slack's tools that send
or schedule messages; `chat:write` is for the drafts.

## WhatsApp

Golem links your number as a device, as WhatsApp Web does, through [wacli](https://github.com/openclaw/wacli). This is
not WhatsApp's own API, and WhatsApp can ban a number that uses it.

1. Install wacli 0.25 or later on the Golem machine, in the `PATH` of the Golem service, for example with
   `brew install openclaw/tap/wacli`, and click **Reload** on Configuration in Settings.
2. In Settings, click **Link number** on WhatsApp, type your number, and click **Get code**.
3. On your phone, open WhatsApp › **Linked devices** › **Link a device** › **Link with phone number instead**, and
   type the code.
4. Click **Done** in Golem.

Your phone then sends Golem the newest messages of each chat, often only some days, and Golem keeps a copy of every new
message while it runs. The copy and the device's keys are in `data/integrations/<credential-id>/`. Agents read chats and
messages, search them, and find contacts. For older messages, ask an agent to load them: it asks your phone, which must
be online, for up to 5000 older messages of a chat at a time. For a message, they make a `wa.me` link that opens WhatsApp with the text; you send it.
Deleting the credential removes the device from your number.

## X

Golem reads your X account through [Rettiwt-API](https://github.com/Rishikant181/Rettiwt-API), with a key made from the
cookies of your X session. This is not X's paid API, and X can limit or ban an account that uses it. The key gives the
same access as your login, so keep it secret, as Golem does.

1. In Firefox, install the [Rettiwt Auth Helper](https://addons.mozilla.org/en-US/firefox/addon/rettiwt-auth-helper)
   extension, and let it run in private windows.
2. Open a private window, and sign in to X.
3. Click the extension, click **Get API Key**, and copy the key. Close the window, but do not sign out: signing out
   ends the key. The key works for about five years, or until you change your password.
4. In Settings, click **Connect** on X, type your handle as the label, and paste the key.

Without Firefox, copy the `auth_token`, `ct0`, and `twid` cookies of x.com from your browser's developer tools, and run
`btoa("auth_token=…;ct0=…;twid=…;")` in its console. The result is the key; it ends when you sign out of that browser.

Agents read your bookmarks, newest first, and posts with their replies and threads. They do not post, like, or change
bookmarks.
