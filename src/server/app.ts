import { existsSync } from "node:fs";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { MODEL_PRICES } from "../shared/pricing.js";
import type { UsageDatabase } from "./database.js";
import { getSummary, getTimeseries, type PoolFilter } from "./queries.js";
import type { SessionFollower } from "./session-follower.js";

interface ServerDependencies {
  database: UsageDatabase;
  follower: SessionFollower;
  now?: () => number;
  clientRoot?: string;
  logger?: boolean;
}

const REFRESH_INTERVAL_MS = 2_000;
const POOLS = new Set<PoolFilter>(["standard", "spark", "other", "all"]);

function parseTime(value: unknown): number | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseRange(query: Record<string, unknown>): { from: number; to: number; pool: PoolFilter } | { error: string } {
  const from = parseTime(query.from);
  const to = parseTime(query.to);
  if (from === null || to === null) return { error: "from and to must be valid ISO timestamps or epoch milliseconds" };
  if (from >= to) return { error: "from must be before to" };
  const pool = typeof query.pool === "string" ? query.pool as PoolFilter : "standard";
  if (!POOLS.has(pool)) return { error: "pool must be standard, spark, other, or all" };
  return { from, to, pool };
}

export function buildServer(dependencies: ServerDependencies): FastifyInstance {
  const app = Fastify({ logger: dependencies.logger ?? false });
  const now = dependencies.now ?? Date.now;

  app.setErrorHandler((error, request, reply) => {
    request.log.error(error);
    reply.status(500).send({ error: "The local usage service could not complete this request." });
  });

  app.get("/api/health", async () => {
    const collector = dependencies.follower.getStatus();
    return {
      collector,
      now: now(),
      lagMs: collector.lastEventAt === null ? null : Math.max(0, now() - collector.lastEventAt)
    };
  });

  app.get("/api/config", async () => ({
    refreshIntervalMs: REFRESH_INTERVAL_MS,
    installedAt: Number(dependencies.database.getMeta("initialized_at") ?? 0) || null,
    pricing: MODEL_PRICES,
    pools: [...POOLS]
  }));

  app.get("/api/summary", async (request, reply) => {
    const range = parseRange(request.query as Record<string, unknown>);
    if ("error" in range) return reply.status(400).send({ error: range.error });
    return getSummary(dependencies.database, range.from, range.to, range.pool);
  });

  app.get("/api/timeseries", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const range = parseRange(query);
    if ("error" in range) return reply.status(400).send({ error: range.error });
    const bucketMs = typeof query.bucketMs === "string" ? Number(query.bucketMs) : undefined;
    if (bucketMs !== undefined && (!Number.isFinite(bucketMs) || bucketMs < 1)) {
      return reply.status(400).send({ error: "bucketMs must be a positive number" });
    }
    return getTimeseries(dependencies.database, range.from, range.to, range.pool, bucketMs);
  });

  if (dependencies.clientRoot && existsSync(dependencies.clientRoot)) {
    void app.register(fastifyStatic, { root: dependencies.clientRoot, prefix: "/" });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) return reply.status(404).send({ error: "API route not found" });
      return reply.sendFile("index.html");
    });
  }

  return app;
}
