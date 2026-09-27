import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server/app.js";

let app: FastifyInstance;

before(async () => {
  app = await buildApp({
    tokenVerifier: async (token) =>
      token === "staff-token"
        ? { sub: "user-1", name: "Support", roles: ["support"] }
        : { sub: "user-2", roles: [] },
    fetchImplementation: async () => new Response("ok", { status: 200 }),
  });
});

after(async () => {
  await app.close();
});

test("health is public and contains no protected configuration", async () => {
  const response = await app.inject({ method: "GET", url: "/health" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    status: "ok",
    service: "LH-Hub",
    version: "0.1.0",
  });
});

test("Hub APIs require an SSO bearer token and a staff role", async () => {
  const missing = await app.inject({ method: "GET", url: "/api/v1/session" });
  assert.equal(missing.statusCode, 401);

  const customer = await app.inject({
    method: "GET",
    url: "/api/v1/session",
    headers: { authorization: "Bearer customer-token" },
  });
  assert.equal(customer.statusCode, 403);

  const staff = await app.inject({
    method: "GET",
    url: "/api/v1/session",
    headers: { authorization: "Bearer staff-token" },
  });
  assert.equal(staff.statusCode, 200);
  assert.deepEqual(staff.json().user.roles, ["support"]);
});

test("service checks run server-side for authorized staff", async () => {
  const response = await app.inject({
    method: "GET",
    url: "/api/v1/overview",
    headers: { authorization: "Bearer staff-token" },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().services.length, 4);
  assert.ok(response.json().services.every((service: { state: string }) => service.state === "operational"));
});
