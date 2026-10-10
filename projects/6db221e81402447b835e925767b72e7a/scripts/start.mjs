import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
// The bundle is the production entry; importing starts it with the same env.
process.env.GAUNTLET_START_SERVER = "1";
await import(pathToFileURL(resolve(process.env.PARTY_OUTPUT_DIR || "dist", "server.mjs")).href);
