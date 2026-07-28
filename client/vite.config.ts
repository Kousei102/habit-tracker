import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In dev the browser only ever talks to :5173; /api is proxied to the API server,
// which keeps requests same-origin so session cookies behave exactly as they do
// in production (where one Node process serves both).
const apiPort = process.env.API_PORT ?? process.env.PORT ?? "3001";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: `http://localhost:${apiPort}`,
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
