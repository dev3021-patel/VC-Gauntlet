import { build } from "esbuild";
import { resolve } from "node:path";
await build({ entryPoints: ["src/production.ts"], outfile: resolve(process.env.PARTY_OUTPUT_DIR || "dist", "server.mjs"), bundle: true, platform: "node", format: "esm", target: "node22" });
