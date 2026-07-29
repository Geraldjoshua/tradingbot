import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Frontend runs on 5173 and proxies /api to the Express backend on 3001,
// so the browser never sees the Alpaca keys.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3001",
    },
  },
});
