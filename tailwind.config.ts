import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
      colors: {
        // Augment forest-green primary palette
        augment: {
          50:  "#f1f7f2",
          100: "#dbeadf",
          200: "#b8d5bf",
          300: "#8db89a",
          400: "#5e9670",
          500: "#3f7853", // base brand
          600: "#306242",
          700: "#264e35", // dark CTAs
          800: "#1f3f2c",
          900: "#152a1d",
        },
        ink: {
          50:  "#fafaf9",
          100: "#f5f5f4",
          200: "#e7e5e4",
          300: "#d6d3d1",
          400: "#a8a29e",
          500: "#78716c",
          600: "#57534e",
          700: "#44403c",
          800: "#292524",
          900: "#1c1917",
        },
      },
    },
  },
  plugins: [],
};

export default config;
