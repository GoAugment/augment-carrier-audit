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
    outputFileTracingIncludes: {
      "/api/analyze": [
        "./data/**/*",
        "./node_modules/duckdb/**/*",
        "./node_modules/.pnpm/duckdb@*/**/*",
        "./node_modules/.pnpm/@mapbox+node-pre-gyp@*/**/*",
      ],
    },
  },
  async headers() {
    return [
      {
        // Allow Framer (and anyone else) to embed /embed in an iframe.
        // The marketing landing page at / is intentionally NOT iframe-embeddable.
        source: "/embed",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors *" },
          { key: "X-Frame-Options", value: "ALLOWALL" },
        ],
      },
    ];
  },
};

export default nextConfig;
