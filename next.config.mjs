/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    typedRoutes: true,
    // duckdb is a native binding; don't try to bundle it. (Renamed to
    // `serverExternalPackages` in Next 15.)
    serverComponentsExternalPackages: ["duckdb"],
    // Ensure the parquet snapshot ships with the analyze serverless function.
    outputFileTracingIncludes: {
      "/api/analyze": ["./data/**/*"],
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
