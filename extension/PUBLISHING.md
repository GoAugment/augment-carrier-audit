# Publishing — Augie Carrier Check (Chrome Web Store, Unlisted)

The store has a **Publish API**, so version updates can be one command. But the
**first** submission (listing fields + screenshots + privacy + review) is done
once in the dashboard — the API automates *upload + publish*, not the initial
listing or Google's review.

## One-time: create the listing (dashboard)
1. https://chrome.google.com/webstore/devconsole (the account that owns
   "Augie Browser") → **New item** → upload `augie-carrier-check.zip`
   (run `pnpm package` to build it).
2. Fill the listing: name **Augie Carrier Check**, description, category
   (Productivity), at least one screenshot, an icon (already bundled).
3. **Visibility → Unlisted** (install-by-link, not publicly searchable).
4. **Privacy practices** — see justifications below; set the **privacy policy
   URL** (the same one used for "Augie Browser").
5. Submit for review. Note the item's **ID** (in the URL / item page).

## One-time: API credentials (for `publish:webstore`)
1. Google Cloud console → enable **Chrome Web Store API**.
2. Create an **OAuth client** (type: Desktop) → client ID + secret.
3. Generate a **refresh token** for the dev account (one-time OAuth consent;
   `chrome-webstore-upload-keys` or the documented curl flow).
4. Put these in your shell (never commit them):
   ```sh
   export EXTENSION_ID=...        # the item ID from the dashboard
   export CLIENT_ID=...
   export CLIENT_SECRET=...
   export REFRESH_TOKEN=...
   ```

## Every release after that
```sh
pnpm publish:webstore       # builds, zips, uploads, and publishes
```
Bump `version` in `src/manifest.json` first (the store rejects a re-upload of
the same version). Each publish still goes through Google review before it
goes live to Unlisted users.

## Permission justifications (each verified against actual API usage)

Permissions: `scripting, storage, tabs, cookies, sidePanel` + host `<all_urls>`.
(`activeTab` was removed — unused and redundant with the host permission.)

- **host `<all_urls>`** — The extension vets a carrier from whatever page the
  broker is on: a carrier's email in Gmail/Outlook, a load/tender in any TMS,
  or an FMCSA SAFER page. The content script reads the visible page on request
  to find the carrier's DOT/MC and re-checks when the page changes. Brokers use
  many different web apps, so the hosts can't be enumerated in advance.
- **cookies** — Reads the Augie `_session` cookie on `*.goaugment.com`
  (`chrome.cookies.get`/`onChanged`) to authenticate the signed-in user so they
  don't log in again inside the extension. Read-only, used solely to obtain the
  session token for Augie's own API; never written, never sent to a third party.
- **scripting** — When a page was already open before the extension loaded (so
  the content script isn't present), the worker injects it once via
  `chrome.scripting.executeScript` to read that page. Without it, checks fail on
  pre-existing tabs.
- **tabs** — Identifies the page to check (`chrome.tabs.query` active tab),
  re-checks automatically when the active tab's URL changes in single-page apps
  like Gmail (`chrome.tabs.onUpdated`), and opens the Augie sign-in page
  (`chrome.tabs.create`). Only the tab the user is checking.
- **storage** — `chrome.storage.local` keeps the user's recent checks (to
  re-open prior results) and, in dev builds only, environment/brokerage test
  settings. No remote storage.
- **sidePanel** — The entire UI is a Chrome side panel (`chrome.sidePanel` +
  the manifest `side_panel` entry).

- **Single purpose** — Vet a freight carrier (FMCSA fraud/safety audit + the
  broker's own history with that carrier) from the page the user is viewing.
- **Remote code** — None; all JS is bundled in the package.
- **Data use** — Reads the Augie session cookie + the visible page to identify
  a carrier, sends the carrier identifier (DOT/MC) to Augie's API, and shows the
  result. No sale or third-party transfer; customer data stays within Augie.
