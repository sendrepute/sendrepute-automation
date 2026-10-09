import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { buildZip, files } from "../scripts/package.mjs";

test("source archive is deterministic and allowlisted", async () => {
  const a = await buildZip();
  const b = await buildZip();
  assert.equal(createHash("sha256").update(a).digest("hex"),
    createHash("sha256").update(b).digest("hex"));
  const text = a.toString("latin1");
  for (const file of files) assert.ok(text.includes(`sendrepute-automation-recipes/${file}`));
  const names = [...text.matchAll(/sendrepute-automation-recipes\/[A-Za-z0-9._/-]+/g)]
    .map((match) => match[0]);
  for (const name of names) {
    assert.ok(!name.includes("/tests/"));
    assert.ok(!name.includes("/fixtures/"));
    assert.ok(!name.includes("/node_modules/"));
    assert.ok(!name.includes("/.env"));
  }
  assert.ok(!text.includes("SENDREPUTE_API_TOKEN=sk_"));
});