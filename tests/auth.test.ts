import assert from "node:assert/strict";
import { test } from "node:test";
import { authorizeClaims, readBearerToken } from "../src/server/auth.js";

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
