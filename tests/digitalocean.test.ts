import assert from "node:assert/strict";
import { test } from "node:test";
import { createDigitalOceanInfrastructureReader } from "../src/server/digitalocean.js";

const testToken = "unit-test-secret-that-is-never-returned";

const metric = (
  values: Array<[number, string]>,
  labels: Record<string, string> = { host_id: "123" },
) => ({
  status: "success",
  data: { resultType: "matrix", result: [{ metric: labels, values }] },
});

test("DigitalOcean Insights calculates resource usage and caches provider calls", async () => {
  const requested: URL[] = [];
  const reader = createDigitalOceanInfrastructureReader({
    token: testToken,
    timeoutMs: 5_000,
    cacheMs: 120_000,
    metricWindowSeconds: 900,
    now: () => 1_700_000_000_000,
    fetchImplementation: async (input, init) => {
      const url = new URL(input);
      requested.push(url);
      assert.equal(init?.headers && new Headers(init.headers).get("authorization"),
        `Bearer ${testToken}`);
      if (url.pathname === "/v2/droplets") {
        return Response.json({
          droplets: [{
            id: 123,
            name: "ams3-api-01",
            memory: 1024,
            vcpus: 1,
            disk: 25,
            status: "active",
            region: { slug: "ams3" },
          }],
          links: {},
        });
      }
      const endpoint = url.pathname.split("/").at(-1);
      if (endpoint === "cpu") {
        return Response.json({
          status: "success",
          data: {
            resultType: "matrix",
            result: [
              { metric: { host_id: "123", mode: "idle" }, values: [[1, "0"], [2, "80"]] },
              { metric: { host_id: "123", mode: "user" }, values: [[1, "0"], [2, "20"]] },
            ],
          },
        });
      }
      if (endpoint === "memory_total") return Response.json(metric([[2, "1000"]]));
      if (endpoint === "memory_free") return Response.json(metric([[2, "200"]]));
      if (endpoint === "memory_cached") return Response.json(metric([[2, "300"]]));
      if (endpoint === "filesystem_size") {
        return Response.json(metric([[2, "1000"]], { host_id: "123", mountpoint: "/" }));
      }
      if (endpoint === "filesystem_free") {
        return Response.json(metric([[2, "250"]], { host_id: "123", mountpoint: "/" }));
      }
      if (endpoint === "load_1") return Response.json(metric([[2, "0.42"]]));
      if (endpoint === "bandwidth") {
        const value = url.searchParams.get("direction") === "inbound" ? "12.34" : "4.56";
        return Response.json(metric([[2, value]]));
      }
      return new Response(null, { status: 404 });
    },
  });

  const [first, concurrent] = await Promise.all([reader(), reader()]);
  assert.deepEqual(concurrent, first);
  const requestCount = requested.length;
  const second = await reader();
  assert.equal(requested.length, requestCount);
  assert.deepEqual(second, first);
  assert.equal(first.state, "ready");
  assert.equal(first.droplets.length, 1);
  assert.deepEqual(first.droplets[0], {
    name: "ams3-api-01",
    status: "active",
    region: "ams3",
    vcpus: 1,
    memoryMiB: 1024,
    diskGiB: 25,
    metricsState: "ready",
    metricsUpdatedAt: "1970-01-01T00:00:02.000Z",
    cpuPercent: 20,
    memoryPercent: 50,
    diskPercent: 75,
    load1: 0.42,
    publicBandwidthInMbps: 12.34,
    publicBandwidthOutMbps: 4.56,
  });
  assert.doesNotMatch(JSON.stringify(first), /unit-test-secret/);
});

test("DigitalOcean provider failures return a stable unavailable response", async () => {
  const reader = createDigitalOceanInfrastructureReader({
    token: testToken,
    timeoutMs: 5_000,
    cacheMs: 120_000,
    metricWindowSeconds: 900,
    fetchImplementation: async () => new Response(null, { status: 503 }),
  });
  assert.deepEqual(await reader(), {
    state: "unavailable",
    fetchedAt: null,
    droplets: [],
    error: "provider_unavailable",
  });
});

test("DigitalOcean provider failures retain the last successful snapshot", async () => {
  let timestamp = 1_700_000_000_000;
  let providerAvailable = true;
  let calls = 0;
  const reader = createDigitalOceanInfrastructureReader({
    token: testToken,
    timeoutMs: 5_000,
    cacheMs: 120_000,
    metricWindowSeconds: 900,
    now: () => timestamp,
    fetchImplementation: async () => {
      calls += 1;
      if (!providerAvailable) return new Response(null, { status: 503 });
      return Response.json({
        droplets: [{
          id: 456,
          name: "fra1-status-01",
          memory: 1024,
          vcpus: 1,
          disk: 25,
          status: "off",
          region: { slug: "fra1" },
        }],
        links: {},
      });
    },
  });

  const fresh = await reader();
  assert.equal(fresh.state, "ready");
  timestamp += 120_001;
  providerAvailable = false;
  const stale = await reader();
  assert.equal(stale.state, "stale");
  assert.equal(stale.droplets[0]?.name, "fra1-status-01");
  const callCount = calls;
  assert.deepEqual(await reader(), stale);
  assert.equal(calls, callCount);
});

test("DigitalOcean integration stays explicitly disabled without a token", async () => {
  const reader = createDigitalOceanInfrastructureReader({
    timeoutMs: 5_000,
    cacheMs: 120_000,
    metricWindowSeconds: 900,
    fetchImplementation: async () => {
      throw new Error("fetch must not run");
    },
  });
  assert.deepEqual(await reader(), {
    state: "not_configured",
    fetchedAt: null,
    droplets: [],
  });
});
