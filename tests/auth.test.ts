import assert from "node:assert/strict";
import { test } from "node:test";
import {
  authorizeClaims,
  capabilitiesFor,
  hasCapability,
  readBearerToken,
} from "../src/server/auth.js";

test("bearer tokens are parsed without accepting other schemes", () => {
  assert.equal(readBearerToken("Bearer token-value"), "token-value");
  assert.equal(readBearerToken("Basic token-value"), null);
  assert.equal(readBearerToken("Bearer   "), null);
});

test("only normalized SSO staff roles grant Hub access", () => {
  assert.deepEqual(
    authorizeClaims({ sub: "user-1", roles: ["support"] }),
    { sub: "user-1", roles: ["support"] },
  );
  assert.equal(authorizeClaims({ sub: "user-2", roles: [] }), null);
  assert.equal(authorizeClaims({ sub: "user-3", roles: ["customer"] }), null);
});

test("staff roles receive only their intended Hub capabilities", () => {
  for (const role of ["founder", "platform_admin"] as const) {
    const capabilities = capabilitiesFor({ roles: [role] });
    assert.equal(capabilities.length, 10);
    assert.equal(capabilities.includes("infrastructure:read"), true);
    assert.equal(capabilities.includes("discord:manage"), true);
    assert.equal(capabilities.includes("maintenance:write"), true);
    assert.equal(capabilities.includes("settings:write"), true);
  }
  assert.equal(capabilitiesFor({ roles: ["management"] }).length, 9);
  assert.equal(capabilitiesFor({ roles: ["management"] }).includes("settings:write"), false);

  assert.deepEqual(capabilitiesFor({ roles: ["developer"] }), [
    "services:read",
    "infrastructure:read",
    "operations:read",
  ]);
  assert.deepEqual(capabilitiesFor({ roles: ["infrastructure"] }), [
    "services:read",
    "infrastructure:read",
    "operations:read",
    "maintenance:write",
  ]);

  assert.deepEqual(capabilitiesFor({ roles: ["support"] }), [
    "services:read",
    "support:read",
    "audit:read",
  ]);
  assert.deepEqual(capabilitiesFor({ roles: ["sales"] }), [
    "services:read",
    "sales:read",
  ]);
  assert.equal(hasCapability({ roles: ["support"] }, "infrastructure:read"), false);
  assert.equal(
    hasCapability({ roles: ["support", "infrastructure"] }, "infrastructure:read"),
    true,
  );
});
