import assert from "node:assert/strict";
import { test } from "node:test";
import { createAuditReader } from "../src/server/audit.js";

test("audit reader sends the short-lived user token only to the configured API", async () => {
  let requestedUrl = "";
  let authorization = "";
  const reader = createAuditReader({
    apiOrigin: "https://api.legacyhosting.xyz",
    timeoutMs: 1_000,
    fetchImplementation: async (input, init) => {
      requestedUrl = input.toString();
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return Response.json({ data: { events: [], nextCursor: null } });
    },
  });
  assert.deepEqual(
    await reader({ accessToken: "short-lived-token", cursor: "page-2" }),
    { events: [], nextCursor: null },
  );
  assert.equal(
    requestedUrl,
    "https://api.legacyhosting.xyz/api/v1/hub/audit-events?limit=50&cursor=page-2",
  );
  assert.equal(authorization, "Bearer short-lived-token");
});

test("audit reader rejects malformed API responses", async () => {
  const reader = createAuditReader({
    apiOrigin: "https://api.legacyhosting.xyz",
    timeoutMs: 1_000,
    fetchImplementation: async () => Response.json({ data: { events: [{ token: "leak" }] } }),
  });
  await assert.rejects(reader({ accessToken: "short-lived-token" }));
});
