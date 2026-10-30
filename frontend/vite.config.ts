import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: "auto",
      includeAssets: ["icons/*.png", "icons/*.svg"],
      manifest: {
        name: "HelixSight AI",
        short_name: "HelixSight",
        description: "Local-first AI bioinformatics workbench",
        theme_color: "#070B14",
        background_color: "#070B14",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,wasm,mjs,onnx,json}"],
        maximumFileSizeToCacheInBytes: 40 * 1024 * 1024,
        navigateFallbackDenylist: [/^\/api\//, /^\/ws\//],
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    host: "127.0.0.1",
    port: 5173,
    headers: isolation,
    proxy: {
      "/api": { target: "http://127.0.0.1:8000", changeOrigin: false },
      "/ws": { target: "ws://127.0.0.1:8000", ws: true },
    },
  },
  preview: { headers: isolation },
  worker: { format: "es" },
  build: {
    target: "es2022",
    sourcemap: true,
    rollupOptions: { output: { manualChunks: { react: ["react", "react-dom"] } } },
  },
  optimizeDeps: { exclude: ["onnxruntime-web"] },
});
