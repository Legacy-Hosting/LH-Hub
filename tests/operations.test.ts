import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createOperationsReader,
  createPublicStatusReader,
} from "../src/server/operations.js";

const platformSummary = {
  generatedAt: "2026-09-27T10:00:00.000Z",
  database: { state: "connected" },
  applications: { total: 4, running: 3, failed: 1, deploying: 0, stopped: 0, pending: 0 },
  agents: { total: 2, online: 2, offline: 0, pending: 0, draining: 0, lastHeartbeatAt: "2026-09-27T09:59:55.000Z" },
  deployments: {
    windowHours: 24,
    total: 2,
    succeeded: 1,
    failed: 1,
    inProgress: 0,
    queued: 0,
    cancelled: 0,
    successRate: 50,
    recent: [],
  },
} as const;

test("operations reader forwards only the short-lived user token to LH-API", async () => {
  let authorization = "";
  const reader = createOperationsReader({
    apiOrigin: "https://api.legacyhosting.xyz",
    timeoutMs: 1_000,
    fetchImplementation: async (input, init) => {
      assert.equal(input.toString(), "https://api.legacyhosting.xyz/api/v1/hub/operations");
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return Response.json({ data: platformSummary });
    },
  });
  assert.equal((await reader("short-lived-token")).deployments.successRate, 50);
  assert.equal(authorization, "Bearer short-lived-token");
});

test("public status reader validates and briefly caches the public snapshot", async () => {
  let requests = 0;
  const reader = createPublicStatusReader({
    statusUrl: "https://status.legacyhosting.xyz/api/v1/status",
    timeoutMs: 1_000,
    cacheMs: 60_000,
    fetchImplementation: async () => {
      requests += 1;
      return Response.json({
        version: 2,
        overall: "operational",
        generatedAt: "2026-09-27T10:00:00.000Z",
        stale: false,
        components: [{
          key: "api",
          name: "API",
          state: "operational",
          latencyMs: 32,
          checkedAt: "2026-09-27T10:00:00.000Z",
        }],
        events: [],
      });
    },
  });
  assert.equal((await reader()).overall, "operational");
  assert.equal((await reader()).components[0]?.latencyMs, 32);
  assert.equal(requests, 1);
});

test("operations readers reject malformed upstream responses", async () => {
  const operations = createOperationsReader({
    apiOrigin: "https://api.legacyhosting.xyz",
    timeoutMs: 1_000,
    fetchImplementation: async () => Response.json({ data: { databasePassword: "leak" } }),
  });
  const status = createPublicStatusReader({
    statusUrl: "https://status.legacyhosting.xyz/api/v1/status",
    timeoutMs: 1_000,
    fetchImplementation: async () => Response.json({ overall: "fine" }),
  });
  await assert.rejects(operations("short-lived-token"));
  await assert.rejects(status());
});
