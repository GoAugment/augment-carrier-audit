/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: { typedRoutes: true },
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
