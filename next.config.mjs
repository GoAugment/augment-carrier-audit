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
        // checkCarrierEmail from lib/email/check.ts → needs both parquets),
        // then sends a SendGrid outbound reply.
        // Bundle: ~158MB parquets + 62MB duckdb/lib + ~13MB SDKs ≈ 238MB.
        // Tight under Vercel's 250MB limit. If we add more data later,
        // consider splitting LLM-extraction into its own function.
        "./data/carrier_aggregates.parquet",
        "./data/carrier_identity.parquet",
        "./data/national_thresholds.json",
        "./node_modules/duckdb/lib/**/*",
        "./node_modules/duckdb/package.json",
        "./node_modules/.pnpm/duckdb@*/node_modules/duckdb/lib/**/*",
        "./node_modules/.pnpm/duckdb@*/node_modules/duckdb/package.json",
        "./node_modules/.pnpm/@mapbox+node-pre-gyp@*/**/*",
      ],
    },
    outputFileTracingExcludes: {
      "/api/analyze": [
        "node_modules/duckdb/src/**",
        "node_modules/duckdb/test/**",
        "node_modules/duckdb/scripts/**",
        "node_modules/.pnpm/duckdb@*/**/src/**",
        "node_modules/.pnpm/duckdb@*/**/test/**",
        "node_modules/.pnpm/duckdb@*/**/scripts/**",
      ],
      "/api/email/inbound": [
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
