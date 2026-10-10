import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

function providerStatusPlugin(): Plugin {
  return {
    name: "provider-status",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/api/provider-status")) {
          next();
          return;
        }
        const configured = Boolean(process.env.OPENAI_API_KEY?.trim());
        const model = process.env.GAUNTLET_MODEL?.trim() || "gpt-4o-mini";
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            configured,
            model,
            message: configured
              ? "Provider configured. VC instructions are registered. Other roles are not, so a full debate is not generated."
              : "AI provider is not configured. Set OPENAI_API_KEY on the server. Sample debates are not used.",
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
