/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    typedRoutes: true,
    // duckdb is a native binding; don't try to bundle it. (Renamed to
    // `serverExternalPackages` in Next 15.)
    serverComponentsExternalPackages: ["duckdb"],
    // Ensure the parquet snapshot AND duckdb's native binding ship with the
    // analyze serverless function. The duckdb glob is needed because pnpm
    // symlinks node_modules/duckdb → .pnpm/duckdb@*/...; Next's file tracer
    // sometimes loses the .node binary across the symlink without an explicit
    // include here.
    //
    // CRITICAL: do NOT include `node_modules/duckdb/**` — that drags in the
    // 67MB of C++ source under `src/` and pushes the function past Vercel's
    // 250MB unzipped limit. We only need `lib/` (the prebuilt binary + JS)
    // and `package.json` (for module resolution). Belt-and-suspenders excludes
    // below catch anything the tracer might still pull in.
    outputFileTracingIncludes: {
      "/api/analyze": [
        "./data/carrier_aggregates.parquet",
        "./data/carrier_risk_signals.parquet",
        "./data/national_thresholds.json",
        "./node_modules/duckdb/lib/**/*",
        "./node_modules/duckdb/package.json",
        "./node_modules/.pnpm/duckdb@*/node_modules/duckdb/lib/**/*",
        "./node_modules/.pnpm/duckdb@*/node_modules/duckdb/package.json",
        "./node_modules/.pnpm/@mapbox+node-pre-gyp@*/**/*",
      ],
      "/api/email/inbound": [
        // Email pipeline is a single Vercel function: receives SendGrid
        // Inbound Parse webhook, calls Anthropic Claude for Stage 1
        // extraction, runs the deterministic verdict (imports
        // checkCarrierEmail from lib/email/check.ts), then sends a reply.
        // carrier_identity.parquet is NOT bundled — it's fetched from Vercel
        // Blob at runtime (see lib/parquet-source.ts) because bundling both
        // parquets (~190MB) + duckdb (62MB) exceeds Vercel's 250MB limit.
        // Aggregates stays bundled: 95MB + 62MB duckdb ≈ 157MB, under the cap.
        "./data/carrier_aggregates.parquet",
        "./data/carrier_risk_signals.parquet",
        "./data/national_thresholds.json",
        "./node_modules/duckdb/lib/**/*",
        "./node_modules/duckdb/package.json",
        "./node_modules/.pnpm/duckdb@*/node_modules/duckdb/lib/**/*",
        "./node_modules/.pnpm/duckdb@*/node_modules/duckdb/package.json",
        "./node_modules/.pnpm/@mapbox+node-pre-gyp@*/**/*",
      ],
      // Single-carrier check route — renders the email-style audit reply
      // (checkCarrierEmail + buildReplyHtml). Same bundle shape as
      // /api/email/inbound: aggregates + risk_signals + duckdb bundled,
      // carrier_identity EXCLUDED (fetched from Blob at runtime) so we stay
      // under the 250MB limit.
      "/check/[dot]": [
        "./data/carrier_aggregates.parquet",
        "./data/carrier_risk_signals.parquet",
        "./data/national_thresholds.json",
        "./lib/data/lane-liability.json",
        "./node_modules/duckdb/lib/**/*",
        "./node_modules/duckdb/package.json",
        "./node_modules/.pnpm/duckdb@*/node_modules/duckdb/lib/**/*",
        "./node_modules/.pnpm/duckdb@*/node_modules/duckdb/package.json",
        "./node_modules/.pnpm/@mapbox+node-pre-gyp@*/**/*",
      ],
      // POST /api/check — captured-page audit (bookmarklet target). Same data
      // path as /check/[dot]: carrier_identity stays Blob-served at runtime.
      "/api/check": [
        "./data/carrier_aggregates.parquet",
        "./data/carrier_risk_signals.parquet",
        "./data/national_thresholds.json",
        "./lib/data/lane-liability.json",
        "./node_modules/duckdb/lib/**/*",
        "./node_modules/duckdb/package.json",
        "./node_modules/.pnpm/duckdb@*/node_modules/duckdb/lib/**/*",
        "./node_modules/.pnpm/duckdb@*/node_modules/duckdb/package.json",
        "./node_modules/.pnpm/@mapbox+node-pre-gyp@*/**/*",
      ],
    },
    outputFileTracingExcludes: {
      "/api/analyze": [
        // carrier_identity.parquet is fetched from Vercel Blob at runtime
        // (lib/parquet-source.ts) — must NOT be bundled or the function busts
        // the 250MB limit. Next's tracer auto-includes it from the literal
        // path string, so exclude it explicitly.
        "data/carrier_identity.parquet",
        "node_modules/duckdb/src/**",
        "node_modules/duckdb/test/**",
        "node_modules/duckdb/scripts/**",
        "node_modules/.pnpm/duckdb@*/**/src/**",
        "node_modules/.pnpm/duckdb@*/**/test/**",
        "node_modules/.pnpm/duckdb@*/**/scripts/**",
      ],
      "/api/email/inbound": [
        "data/carrier_identity.parquet",
        "node_modules/duckdb/src/**",
        "node_modules/duckdb/test/**",
        "node_modules/duckdb/scripts/**",
        "node_modules/.pnpm/duckdb@*/**/src/**",
        "node_modules/.pnpm/duckdb@*/**/test/**",
        "node_modules/.pnpm/duckdb@*/**/scripts/**",
      ],
      "/check/[dot]": [
        "data/carrier_identity.parquet",
        "node_modules/duckdb/src/**",
        "node_modules/duckdb/test/**",
        "node_modules/duckdb/scripts/**",
        "node_modules/.pnpm/duckdb@*/**/src/**",
        "node_modules/.pnpm/duckdb@*/**/test/**",
        "node_modules/.pnpm/duckdb@*/**/scripts/**",
      ],
      "/api/check": [
        "data/carrier_identity.parquet",
        "node_modules/duckdb/src/**",
        "node_modules/duckdb/test/**",
        "node_modules/duckdb/scripts/**",
        "node_modules/.pnpm/duckdb@*/**/src/**",
        "node_modules/.pnpm/duckdb@*/**/test/**",
        "node_modules/.pnpm/duckdb@*/**/scripts/**",
      ],
    },
  },
  async headers() {
    return [
      {
        // Allow Framer (and anyone else) to embed /embed in an iframe.
        // The marketing landing page at / is intentionally NOT iframe-embeddable.
        //
        // Note: do NOT set X-Frame-Options. The spec only defines DENY,
        // SAMEORIGIN, and ALLOW-FROM — there's no valid "allow all" value.
        // "ALLOWALL" is non-standard; some browsers treat it as DENY and
        // block the iframe. CSP `frame-ancestors *` is the standards-compliant
        // way to permit embedding from anywhere, and modern browsers prefer
        // CSP over X-Frame-Options anyway.
        source: "/embed",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors *" },
        ],
      },
    ];
  },
};

export default nextConfig;
