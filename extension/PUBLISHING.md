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

## Permission justifications (mirror "Augie Browser", trimmed to our subset)
- **cookies** — read the Augie `_session` cookie on `*.goaugment.com` to
  authenticate the signed-in user (no separate login); never written or sent
  anywhere except Augie's own API.
- **host `<all_urls>`** — the user checks a carrier from whatever page they're
  on (Gmail/Outlook email, a TMS load, an FMCSA SAFER page), so the content
  script must be able to read the active page on request.
- **tabs / activeTab / scripting** — read the active tab's URL + content when
  the user runs a check, and re-check on SPA navigation.
- **storage** — remember the user's recent checks + (dev only) environment.
- **sidePanel** — the UI is a side panel.
- **Single purpose** — vet a freight carrier (FMCSA fraud audit + the
  brokerage's own history with that carrier) from the page the user is viewing.
- **Remote code** — none; all code is bundled.
- **Data use** — reads the Augie session cookie + the visible page to identify
  a carrier; sends the carrier identifier (DOT/MC) to Augie's API; shows the
  result. No selling/transfer of data; customer data stays within Augie.
