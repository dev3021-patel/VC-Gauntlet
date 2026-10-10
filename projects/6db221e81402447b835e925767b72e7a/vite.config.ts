import react from "@vitejs/plugin-react";
import { join } from "node:path";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
import { handleApi } from "./src/server";

function providerStatusPlugin(): Plugin {
  return {
    name: "provider-status",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        void handleApi(req, res).then((handled) => { if (!handled) next(); }).catch(() => {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: "The request could not be completed." }));
        });
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
  build: { outDir: join(process.env.PARTY_OUTPUT_DIR || "dist", "client") },
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
