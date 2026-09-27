import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createHubSettingsService } from "../src/server/settings.js";

test("Hub settings validate and encrypt DigitalOcean tokens at rest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lh-hub-settings-"));
  const file = join(directory, "settings.enc.json");
  const token = `dop_v1_${"x".repeat(48)}`;
  try {
    const service = createHubSettingsService({
      file,
      encryptionKey: "a".repeat(64),
      timeoutMs: 5_000,
      fetchImplementation: async (_url, options) => {
        assert.equal(new Headers(options?.headers).get("authorization"), `Bearer ${token}`);
        return new Response(JSON.stringify({ account: {} }), { status: 200 });
      },
    });
    assert.deepEqual(await service.digitalOceanStatus(), { configured: false, source: "none" });
    await service.saveDigitalOceanToken(token);
    assert.equal(await service.digitalOceanToken(), token);
    assert.equal((await readFile(file, "utf8")).includes(token), false);
    assert.deepEqual(await service.digitalOceanStatus(), { configured: true, source: "stored" });
    await service.clearDigitalOceanToken();
    assert.deepEqual(await service.digitalOceanStatus(), { configured: false, source: "none" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
