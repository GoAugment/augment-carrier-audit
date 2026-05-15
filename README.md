# augment-carrier-audit

Free, anonymous pre-tender carrier safety audit for freight brokers. Built for the
post-_Montgomery v. Caribe Transport II_ negligent-hiring era.

## Run locally

```bash
pnpm install
cp .env.example .env.local
# Fill in FMCSA_WEBKEY at minimum
pnpm dev
```

Open http://localhost:3000.

## Deploy

```bash
# First-time: link the project to Vercel
vercel link

# Set required env vars in Vercel
vercel env add FMCSA_WEBKEY production
# (Optionally override thresholds — defaults are baked in)

# Connect Vercel KV (Storage tab → Create → KV → Connect)
# That auto-populates KV_URL / KV_REST_API_URL / KV_REST_API_TOKEN

# Deploy
vercel --prod
```

## Architecture

- **Next.js 14 App Router** on Vercel Pro (60s function timeout)
- **FMCSA QCMobile** for live carrier safety data
- **Vercel KV** caches FMCSA responses 24h (saves 90%+ on repeat lookups)
- **No database** — submission analytics emitted as structured `console.log` JSON,
  Vercel forwards to Datadog if the Datadog integration is connected
- **No PII** — IPs hashed; carrier/load IDs not persisted

## Thresholds

Defaults (override via env):

| Metric | Default | Env var |
|---|---:|---|
| Crash rate per truck (24mo) | 0.20 | `THRESHOLD_CRASH_PER_TRUCK` |
| Driver OOS rate | 10% | `THRESHOLD_DRIVER_OOS` |
| Vehicle OOS rate | 40% | `THRESHOLD_VEHICLE_OOS` |
| Hazmat OOS rate | 5% | `THRESHOLD_HAZMAT_OOS` |
| Max loads per submission | 100 | `MAX_LOADS_PER_SUBMISSION` |

Cutoffs derived from FMCSA SMS Methodology v3.0.4 §4.6 (Crash Indicator BASIC P85
framework), rounded from a 1,356-carrier industry sample.

## Statistical method

For each safety axis, the carrier's observed rate is bounded by a Wilson 95% CI
(Wilson, E.B. 1927). A flag fires only when the CI lower bound exceeds the cutoff —
small-sample noise (e.g. 1-of-1 inspections) doesn't trigger.

## License

MIT
