# Augie Carrier Check — browser extension

A single Manifest V3 extension that vets the carrier on whatever page the broker
is looking at (a load, an email, a TMS carrier record). Two tiers, decided
automatically by whether the user is signed in to Augie — **no separate login**:

| Tier | Who | What they see |
|------|-----|---------------|
| **Public** | anyone | The FMCSA fraud / safety audit (same engine as the `/api/check` bookmarklet). |
| **Private** | signed-in Augie users | The audit **plus** this brokerage's **lane history**, the **owning rep**, and **days since last shipment (DSLS)**. |

## How auth works (no login prompt)

The extension never asks for a password. It reads the augment-web session
cookies (`_session` / `_session-extended`) that `app.goaugment.com` already sets
when the user is signed in to Augie, decodes the Bearer `accessToken` + claims,
and uses them for the private call. This is the same pattern
`@goaugment/browser-automation` uses. Claims carry `brokerageKey`, which scopes
all enrichment to that one brokerage **server-side** — the client never asks for
a brokerage. No cookie → public tier, silently.

See `src/background.ts` (the `Auth` section) and `src/types.ts`.

## Architecture

```
content.ts   captures the page (outerHTML + selection + form fields)
   │  CAPTURE_PAGE
   ▼
background.ts
   ├─ POST capture → augment-carrier-audit.vercel.app/api/check   (PUBLIC, no auth)
   │     ← audit HTML + x-carrier-dot / x-carrier-mc headers
   └─ if signed in: GET directory-service …/carriers/enrichment   (PRIVATE, Bearer)
         ← { dsls, lanes[], repOwner, loadCount }   scoped to brokerageKey
   ▼
sidepanel   renders the audit (sandboxed iframe) + the enrichment card
```

The public audit and the private enrichment come from **different backends on
purpose**: the public carrier-audit app ships only public FMCSA data, and the
customer-private data stays behind the augment-services auth perimeter.

## Enrichment endpoint — not built yet

`USE_STUB_ENRICHMENT = true` in `src/background.ts` serves realistic mock data
so the signed-in UI is demoable end-to-end today. To go live:

1. Build `GET /unstable/carriers/enrichment?dotNumber=&mcNumber=` in
   directory-service. It must derive `brokerageKey` from the Bearer token (never
   the query), `authorizeBrokerage`, resolve DOT/MC → carrierId
   (`/unstable/carriers/.../common-identifier`), look up the owning rep
   (`/unstable/carrier-managers/carrier/{carrierId}`), and aggregate
   loads-by-carrier from load-service for DSLS + lanes. Return the
   `CarrierEnrichment` shape in `src/types.ts`.
2. Allow the `chrome-extension://<id>` origin in the gateway CORS config.
3. Verify the host in `ENRICHMENT_BASE`, set `USE_STUB_ENRICHMENT = false`.

> Customer-data-behind-auth + a new external surface needs a Security review
> before customer launch. Tenant isolation must be enforced server-side.

## Build & load

```bash
cd extension
pnpm install
pnpm build          # → extension/dist
# pnpm watch        # rebuild on change
```

Then in Chrome: `chrome://extensions` → enable Developer mode → **Load unpacked**
→ select `extension/dist`. Click the toolbar icon on any load/email page to open
the side panel.

`pnpm package` produces `augie-carrier-check.zip` for the Web Store.
