import { defineConfig } from "vite";

// FastAPI serves web/dist in production. The dev server is for development
// only: it binds to loopback and proxies /api to the configured backend port.
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rolldownOptions: {
      onwarn(warning, defaultHandler) {
        // "use client" in the icon library means nothing in a client-only app.
        if (warning.code === "MODULE_LEVEL_DIRECTIVE") return;
        defaultHandler(warning);
      },
    },
  },
  server: {
    headers: { "X-Frame-Options": "SAMEORIGIN" },
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: { "/api": { target: `http://127.0.0.1:${process.env.PORT || 8080}`, changeOrigin: false } },
  },
});
