# Google Sign-In

Golem has no passwords and no sign-up. People sign in with their Google account, and only the emails in
`config/golem.toml` can sign in. Do these steps one time for each Golem server. One Google OAuth client is
sufficient for the web app and the iOS app.

The examples use `golem.example.com` for the Golem address and `you@gmail.com` and `partner@gmail.com` for the two
people. Use your values.

## 1. Give Golem an HTTPS address

Google sends people back to Golem after sign-in. Google accepts only an `https` address on a public domain, or
`http://localhost` for development. A private hostname or a raw IP address does not work.

1. In the DNS of your domain, add an `A` record for `golem.example.com` that points to the server's private IP
   address. The name is public, but only devices on your private network can open it.
2. Get a TLS certificate for `golem.example.com`. Let's Encrypt cannot reach a private IP address, so use the DNS
   challenge. For example, run [Caddy](https://caddyserver.com) with the DNS module of your DNS provider, as a reverse
   proxy to `localhost:3000`.
3. Make sure that `https://golem.example.com` opens Golem from your devices.

## 2. Set up the Google Auth Platform

1. Open the [Google Cloud console](https://console.cloud.google.com) and select your project.
2. Open **Google Auth Platform**. If the console asks you to configure it, click **Get started**.
3. In **Branding**:
   - **App name**: `Golem`.
   - **User support email**: your email.
   - **Authorized domains**: add `example.com`, the domain of the Golem address.
   - **Developer contact information**: your email.
   - Click **Save**.
4. In **Audience**:
   - **User type**: **External**. This is necessary for `@gmail.com` accounts.
   - Keep **Publishing status** at **Testing**. Then Google also lets only test users sign in.
   - Under **Test users**, click **Add users** and add `you@gmail.com` and `partner@gmail.com`.
5. In **Data access**, you do not have to add scopes. Golem asks only for `openid`, `email`, and `profile`. These
   scopes do not need Google verification.

## 3. Create the OAuth client

1. In **Google Auth Platform**, open **Clients** and click **Create client**.
2. **Application type**: **Web application**. **Name**: `Golem`.
3. Under **Authorized redirect URIs**, add:
   - `https://golem.example.com/api/auth/callback/google`
   - `http://localhost:3000/api/auth/callback/google`, only if you also run Golem on your computer for development.
4. You do not have to add **Authorized JavaScript origins**.
5. Click **Create**. Copy the **Client ID** and the **Client secret** immediately. Google can show the secret only
   now. If you lose it, add a new secret to the client.

## 4. Configure Golem

Golem creates `config/golem.toml` on the first start. The `config/` folder is not in Git, and it is not in the data
backup. Keep a copy of it in a safe place. Edit the file:

```toml
base_url = "https://golem.example.com"
port = 3000

allowed_emails = ["you@gmail.com", "partner@gmail.com"]

[google]
client_id = "1234567890-abc.apps.googleusercontent.com"
client_secret = "GOCSPX-..."
```

- `base_url` must be the same address as in the redirect URI, without the path.
- `allowed_emails` is the only list of people who can sign in. If you remove an email, that person cannot sign in
  again.

Restart Golem. Golem does not start if `client_id` or `client_secret` is empty.

## 5. Sign in

- **Web**: open `https://golem.example.com` and click **Continue with Google**.
- **iOS**: type `https://golem.example.com` in **Server**, then tap **Continue with Google**.

To add your partner to a workspace, they must sign in one time. Then open the workspace settings and add their email
under **Members**.

If you made an account with a password before Google sign-in, sign in with Google with the same email. Golem connects
the Google account to it, and you keep your workspaces.

## Problems

| Message | Cause and fix |
| --- | --- |
| `Error 400: redirect_uri_mismatch` | `base_url` is not the same as the redirect URI in the client. Make them the same. |
| `Access blocked: Golem has not completed the Google verification process` | The account is not a test user. Add it in **Audience**. |
| `This Google account cannot sign in to Golem.` | The email is not in `allowed_emails`. Add it and restart Golem. |
| `config/golem.toml: google.client_id must be a text value` | Step 4 is not complete. |
