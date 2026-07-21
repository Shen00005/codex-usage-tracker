import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildServer } from "./app.js";
import { UsageDatabase } from "./database.js";
import { SessionFollower } from "./session-follower.js";

const port = Number(process.env.CODEX_USAGE_PORT ?? 4319);
const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
const dataDirectory = resolve(process.env.CODEX_USAGE_DATA_DIR ?? join(localAppData, "CodexUsageTracker"));
const sessionRoot = resolve(process.env.CODEX_SESSIONS_ROOT ?? join(homedir(), ".codex", "sessions"));
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const clientRoot = resolve(moduleDirectory, "..", "..", "client");

mkdirSync(dataDirectory, { recursive: true });
const database = new UsageDatabase(join(dataDirectory, "usage.sqlite"));
const follower = new SessionFollower(sessionRoot, database, { intervalMs: 2_000 });
const app = buildServer({ database, follower, clientRoot, logger: true });

const shutdown = async () => {
  follower.stop();
  await app.close();
  database.close();
};

process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));

follower.start();
await app.listen({ host: "127.0.0.1", port });
