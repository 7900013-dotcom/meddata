import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The API serves /api and /auth; in development Vite proxies both so cookies stay same-origin.
export default defineConfig({
  // VITE_DEMO=1 builds the self-contained demo (in-browser backend, relative asset paths, hash routes).
  base: process.env.VITE_DEMO === "1" ? "./" : "/",
  build: { outDir: process.env.VITE_DEMO === "1" ? "dist-demo" : "dist" },
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:4000", "/auth": "http://localhost:4000" },
  },
});
