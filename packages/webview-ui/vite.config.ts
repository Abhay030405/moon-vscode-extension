// Builds the Moon panel into the extension's dist/webview folder with fixed file names,
// so the extension can load index.js / index.css without reading a manifest.

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // Relative URLs: the webview serves these files from its own resource path, not a site root.
  base: "./",
  build: {
    outDir: "../extension/dist/webview",
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: "src/main.tsx",
      output: {
        entryFileNames: "index.js",
        // index.css keeps a fixed name for the extension; images keep their own names.
        assetFileNames: (asset) => (asset.names.some((n) => n.endsWith(".css")) ? "index[extname]" : "[name][extname]"),
        chunkFileNames: "[name].js",
      },
    },
  },
});
