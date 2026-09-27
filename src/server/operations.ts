import { z } from "zod";
import type { FetchImplementation } from "./service-health.js";

const deploymentStatus = z.enum([
  "queued",
  "building",
  "deploying",
  "succeeded",
  "failed",
  "rolled_back",
  "cancelled",
]);

const operationsSummarySchema = z.object({
  generatedAt: z.string().datetime(),
  database: z.object({ state: z.literal("connected") }),
  applications: z.object({
    total: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    deploying: z.number().int().nonnegative(),
    stopped: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
  }),
  agents: z.object({
    total: z.number().int().nonnegative(),
    online: z.number().int().nonnegative(),
    offline: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    draining: z.number().int().nonnegative(),
    lastHeartbeatAt: z.string().datetime().nullable(),
  }),
  deployments: z.object({
    windowHours: z.literal(24),
    total: z.number().int().nonnegative(),
    succeeded: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    inProgress: z.number().int().nonnegative(),
    queued: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
    successRate: z.number().min(0).max(100).nullable(),
    recent: z.array(z.object({
      id: z.string().uuid(),
      applicationName: z.string().min(1).max(80),
      teamName: z.string().min(1).max(160),
      status: deploymentStatus,
      source: z.enum(["manual", "github_push", "rollback"]),
      commitSha: z.string().regex(/^[0-9a-f]{40}$/i).nullable(),
      createdAt: z.string().datetime(),
      startedAt: z.string().datetime().nullable(),
      finishedAt: z.string().datetime().nullable(),
    })).max(12),
  }),
});

const apiResponseSchema = z.object({ data: operationsSummarySchema });

const statusEventSchema = z.object({
  id: z.string().min(1).max(64),
  type: z.enum(["incident", "maintenance"]),
  title: z.string().min(1).max(120),
  message: z.string().min(1).max(1_000),
  impact: z.enum(["none", "minor", "major", "critical"]),
  status: z.enum([
    "investigating",
    "identified",
    "monitoring",
    "resolved",
    "scheduled",
    "in_progress",
    "completed",
  ]),
  components: z.array(z.string().min(1).max(32)).max(30),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const publicStatusSchema = z.object({
  version: z.literal(2),
  overall: z.enum([
    "operational",
    "degraded",
    "partial_outage",
    "major_outage",
    "unknown",
  ]),
  generatedAt: z.string().datetime().nullable(),
  stale: z.boolean(),
  components: z.array(z.object({
    key: z.string().min(1).max(32),
    name: z.string().min(1).max(80),
    state: z.enum(["operational", "degraded", "outage", "unknown"]),
    latencyMs: z.number().int().nonnegative().nullable(),
    checkedAt: z.string().datetime().nullable(),
  })).max(30),
  events: z.array(statusEventSchema).max(100),
});

export type OperationsSummary = z.infer<typeof operationsSummarySchema>;
export type PublicStatusSnapshot = z.infer<typeof publicStatusSchema>;
export type OperationsReader = (accessToken: string) => Promise<OperationsSummary>;
export type PublicStatusReader = () => Promise<PublicStatusSnapshot>;

export function createOperationsReader(options: {
  apiOrigin: string;
  timeoutMs: number;
  fetchImplementation?: FetchImplementation;
}): OperationsReader {
  const url = new URL("/api/v1/hub/operations", options.apiOrigin);
  const fetchImplementation = options.fetchImplementation ?? fetch;
  return async (accessToken) => {
    const response = await fetchImplementation(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
      },
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (!response.ok) throw new Error(`operations_api_${response.status}`);
    return apiResponseSchema.parse(await response.json()).data;
  };
}

export function createPublicStatusReader(options: {
  statusUrl: string;
  timeoutMs: number;
  fetchImplementation?: FetchImplementation;
  cacheMs?: number;
}): PublicStatusReader {
  const url = new URL(options.statusUrl);
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const cacheMs = options.cacheMs ?? 15_000;
  let cache: { expiresAt: number; snapshot: PublicStatusSnapshot } | null = null;
  return async () => {
    const now = Date.now();
    if (cache && cache.expiresAt > now) return cache.snapshot;
    const response = await fetchImplementation(url, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (!response.ok) throw new Error(`public_status_${response.status}`);
    const snapshot = publicStatusSchema.parse(await response.json());
    cache = { expiresAt: now + cacheMs, snapshot };
    return snapshot;
  };
}
