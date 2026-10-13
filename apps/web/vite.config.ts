import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The API serves /api and /auth; in development Vite proxies both so cookies stay same-origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:4000", "/auth": "http://localhost:4000" },
  },
});
