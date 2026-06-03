import * as esbuild from "esbuild";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isWatch = process.argv.includes("--watch");

const distDir = path.join(__dirname, "dist");
fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });

// Static assets copied verbatim into dist/.
const staticFiles = [
  "manifest.json",
  "sidepanel/sidepanel.html",
  "sidepanel/sidepanel.css",
  "icons",
];
for (const file of staticFiles) {
  const src = path.join(__dirname, "src", file);
  const dest = path.join(distDir, file);
  if (!fs.existsSync(src)) continue;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

const buildOptions: esbuild.BuildOptions = {
  entryPoints: [
    "src/background.ts",
    "src/content.ts",
    "src/sidepanel/sidepanel.ts",
  ],
  bundle: true,
  outdir: "dist",
  // background.js sits at dist/background.js; sidepanel.js at dist/sidepanel/.
  outbase: "src",
  format: "esm",
  target: "chrome110",
  sourcemap: isWatch,
  minify: !isWatch,
};

if (isWatch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.log("Watching for changes…");
} else {
  await esbuild.build(buildOptions);
  console.log("Build complete → extension/dist");
}
