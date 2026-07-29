import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// A purely static build (AC-7.2): `vite build` writes client/dist and nothing
// else is needed to run it. There is no dev proxy any more because there is no
// API — the app's data lives in the browser's localStorage, so the dev server and
// a plain static file server behave identically.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
