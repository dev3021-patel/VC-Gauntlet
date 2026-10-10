import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { handleApi } from "./server";

const contentTypes: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json" };

export function createApplication(clientDirectory: string) {
  const root = resolve(clientDirectory);
  return createServer(async (req, res) => {
    try {
      if (await handleApi(req, res)) return;
      const path = decodeURIComponent(new URL(req.url || "/", "http://localhost").pathname);
      if (path.startsWith("/api/")) { res.writeHead(404).end("API endpoint not found."); return; }
      if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { allow: "GET, HEAD" }).end(); return; }
      const target = resolve(root, `.${path}`);
      if (target !== root && !target.startsWith(`${root}${sep}`)) { res.writeHead(403).end(); return; }
      let file = target;
      try {
        if (!(await stat(file)).isFile()) file = resolve(root, "index.html");
      } catch {
        if (extname(path)) { res.writeHead(404).end(); return; }
        file = resolve(root, "index.html");
      }
      const content = await readFile(file);
      res.writeHead(200, { "content-type": contentTypes[extname(file)] || "application/octet-stream", "x-content-type-options": "nosniff" });
      res.end(req.method === "HEAD" ? undefined : content);
    } catch {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "The request could not be completed." }));
      else res.end();
    }
  });
}

export function listenHost(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.HOST?.trim();
  if (configured) return configured;
  return env.RAILWAY_ENVIRONMENT ? "0.0.0.0" : "127.0.0.1";
}

if (process.env.GAUNTLET_START_SERVER === "1") {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer from 1 to 65535.");
  const host = listenHost();
  createApplication(resolve(dirname(fileURLToPath(import.meta.url)), "client")).listen(port, host, () => {
    console.log(`Venture Gauntlet is listening on ${host} port ${port}.`);
  });
}
