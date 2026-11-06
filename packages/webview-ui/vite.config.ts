// Builds the Moon panel into the extension's dist/webview folder with fixed file names,
// so the extension can load index.js / index.css without reading a manifest.

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "../extension/dist/webview",
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: "src/main.tsx",
      output: {
        entryFileNames: "index.js",
        assetFileNames: "index[extname]",
        chunkFileNames: "[name].js",
      },
    },
  },
});
