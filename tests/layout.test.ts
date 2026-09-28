import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");

test("Hub keeps the outer shell non-scrollable while content can scroll", () => {
  const shell = css.match(/\.shell\s*\{[^}]*\}/)?.[0] ?? "";
  const main = css.match(/(?:^|\n)main\s*\{[^}]*\}/)?.[0] ?? "";
  const content = css.match(/\.content\s*\{[^}]*\}/)?.[0] ?? "";

  assert.match(shell, /overflow:\s*clip/);
  assert.match(shell, /grid-template-rows:\s*minmax\(0,\s*1fr\)/);
  assert.match(main, /overflow:\s*clip/);
  assert.match(content, /overflow-y:\s*auto/);
});
