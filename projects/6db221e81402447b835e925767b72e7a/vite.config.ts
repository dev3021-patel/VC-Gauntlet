import react from "@vitejs/plugin-react";
import { join } from "node:path";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
import { handleDebateApi } from "./src/server";
import { providerStatus } from "./src/provider";

function providerStatusPlugin(): Plugin {
  return {
    name: "provider-status",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.startsWith("/api/debate/")) { void handleDebateApi(req, res); return; }
        if (!req.url?.startsWith("/api/provider-status")) {
          next();
          return;
        }
        const status = providerStatus();
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            configured: status.configured,
            model: status.model,
            message: status.message,
          }),
        );
      });
    },
  };
}

const hmrPort = process.env.VITE_HMR_CLIENT_PORT
  ? Number(process.env.VITE_HMR_CLIENT_PORT)
  : undefined;

export default defineConfig({
  plugins: [react(), providerStatusPlugin()],
  cacheDir: join(process.env.XDG_CACHE_HOME || "node_modules/.cache", "venture-gauntlet-vite"),
  build: { outDir: process.env.PARTY_OUTPUT_DIR || "dist" },
  server: {
    host: "127.0.0.1",
    allowedHosts: true,
    hmr: hmrPort ? { clientPort: hmrPort } : undefined,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
