import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { visibleEmailText } from "../../../artifacts/api-server/src/lib/classifier-features.ts";
import { ProxyPolicy } from "../examples/proxy-policy.mjs";

const fixture = JSON.parse(await readFile(new URL("./fixtures/success.json", import.meta.url)));
const openapi = JSON.parse(await readFile(
  new URL("../../../artifacts/api-server/src/customer-api-openapi.json", import.meta.url)
));
const schema = JSON.parse(await readFile(
  new URL("../examples/classify-response.schema.json", import.meta.url)
));

test("public POST contract has exact request and nested response", () => {
  const post = openapi.paths["/v1/classify"].post;
  assert.equal(post.requestBody.content["application/json"].schema.$ref,
    "#/components/schemas/CustomerClassificationInput");
  assert.deepEqual(openapi.components.schemas.CustomerClassificationInput.required,
    ["sender", "subject", "body"]);
  assert.deepEqual(openapi.components.schemas.CustomerClassificationResponse.required,
    ["requestId", "model", "result", "billing"]);
});

test("bundled schema exactly mirrors all transitive OpenAPI response schemas", () => {
  const expectedNames = new Set();
  const visit = (name) => {
    if (expectedNames.has(name)) return;
    expectedNames.add(name);
    const text = JSON.stringify(openapi.components.schemas[name]);
    for (const match of text.matchAll(/#\/components\/schemas\/([^"]+)/g)) visit(match[1]);
  };
  visit("CustomerClassificationResponse");
  assert.deepEqual(new Set(Object.keys(schema.$defs)), expectedNames);
  for (const name of expectedNames) {
    const expected = JSON.parse(JSON.stringify(openapi.components.schemas[name])
      .replaceAll("#/components/schemas/", "#/$defs/"));
    assert.deepEqual(schema.$defs[name], expected);
  }
});

test("Zapier paid gate is compile-time false by default", async () => {
  const source = await readFile(new URL("../zapier/preflight.js", import.meta.url), "utf8");
  assert.match(source, /const ENABLED = false;/);
  assert.match(source, /const PAID_CONSENT = false;/);
  assert.throws(() => vm.runInNewContext(source, { inputData: {
    sender: "Store", subject: "Update", body: "Your order shipped."
  } }));
});

test("exact Zapier preflight works only after deliberate opt-in and rejects transformations", async () => {
  const original = await readFile(new URL("../zapier/preflight.js", import.meta.url), "utf8");
  const source = original
    .replace("const ENABLED = false;", "const ENABLED = true;")
    .replace("const PAID_CONSENT = false;", "const PAID_CONSENT = true;");
  const valid = { inputData: {
    sender: "Store", subject: "Update", body: "Your order shipped."
  } };
  vm.runInNewContext(source, valid);
  assert.equal(valid.output.body, "Your order shipped.");
  for (const fields of [
    { sender: "alpha font-family omega", subject: "Update", body: "Safe body" },
    { sender: "Store", subject: "alpha  omega", body: "Safe body" },
    { sender: "Store", subject: "Update", body: "benign=3Cstyle=3Elater" }
  ]) assert.throws(() => vm.runInNewContext(source, { inputData: fields }));
});

test("real normalizer regression vectors are rejected, not treated as identity", async () => {
  const original = await readFile(new URL("../zapier/preflight.js", import.meta.url), "utf8");
  const source = original
    .replace("const ENABLED = false;", "const ENABLED = true;")
    .replace("const PAID_CONSENT = false;", "const PAID_CONSENT = true;");
  const vectors = [
    "<script>later visible content",
    "benign=3Cstyle=3Elater fragment",
    "alpha line-height omega",
    Buffer.from("<script>hidden</script>later fragment".repeat(4)).toString("base64")
  ];
  for (const body of vectors) {
    assert.notEqual(visibleEmailText(body), body);
    assert.throws(() => vm.runInNewContext(source, {
      inputData: { sender: "Store", subject: "Update", body }
    }));
  }
});

test("complete Zapier response validator accepts fixture", async () => {
  const source = await readFile(new URL("../zapier/validate-response.js", import.meta.url), "utf8");
  const context = { inputData: { status: "200", response: JSON.stringify(fixture) } };
  vm.runInNewContext(source, context);
  assert.equal(context.output.spamProbability, 0.91);
});

test("validator rejects status, enum, required-field, and unknown-property drift", async () => {
  const source = await readFile(new URL("../zapier/validate-response.js", import.meta.url), "utf8");
  const run = (status, value) => vm.runInNewContext(source, {
    inputData: { status: String(status), response: JSON.stringify(value) }
  });
  assert.throws(() => run(503, fixture));
  assert.throws(() => run(200, { ...fixture, model: "lookalike" }));
  assert.throws(() => run(200, {
    ...fixture, result: { ...fixture.result, confidence: undefined }
  }));
  assert.throws(() => run(200, { ...fixture, unexpected: true }));
  assert.throws(() => run(200, {
    ...fixture, billing: { chargedMillicents: 1, replayed: false, extra: true }
  }));
});

test("curl transport is fixed, bounded, and does not retry or redirect", async () => {
  const source = await readFile(new URL("../examples/classify.sh", import.meta.url), "utf8");
  assert.match(source, /https:\/\/www\.sendrepute\.com\/api\/v1\/classify/);
  assert.match(source, /--connect-timeout 3/);
  assert.match(source, /--max-time 10/);
  assert.match(source, /--max-filesize 1048576/);
  assert.match(source, /--max-redirs 0/);
  assert.doesNotMatch(source, /--retry|--location/);
});

test("Zapier proxy has false server gates and fixed bounded one-shot TLS transport", async () => {
  const source = await readFile(new URL("../examples/proxy.mjs", import.meta.url), "utf8");
  assert.match(source, /SENDREPUTE_ENABLED/);
  assert.match(source, /SENDREPUTE_PAID_CONSENT/);
  assert.match(source, /hostname: "www\.sendrepute\.com"/);
  assert.match(source, /path: "\/api\/v1\/classify"/);
  assert.match(source, /MAX_BYTES = 1024 \* 1024/);
  assert.match(source, /TLS connect timeout/);
  assert.match(source, /Upstream total timeout/);
  assert.match(source, /server\.headersTimeout = 5000/);
  assert.match(source, /server\.requestTimeout = 10000/);
  assert.match(source, /server\.timeout = 10000/);
  assert.match(source, /server\.maxConnections = maxConnections/);
  assert.match(source, /res\.writeHead\(413/);
  assert.doesNotMatch(source, /\bretry(?!-after)\b|followRedirect|location:/i);
});

test("proxy policy authenticates revocable IDs and enforces paid boundaries", () => {
  let now = Date.parse("2025-01-01T00:00:00Z");
  const persisted = [];
  const policy = new ProxyPolicy({
    credentials: { zapA: "0123456789abcdef", zapB: "fedcba9876543210" },
    ratePerMinute: 2,
    perCredentialConcurrency: 1,
    globalConcurrency: 1,
    dailyBudget: 2,
    budget: { day: "2025-01-01", calls: 0 },
    persistBudget: (value) => persisted.push({ ...value }),
    now: () => now
  });
  assert.equal(policy.authenticate("Bearer zapA.0123456789abcdef"), "zapA");
  assert.equal(policy.authenticate("Bearer zapA.wrongwrongwrong1"), null);
  const releaseFirst = policy.acquire("zapA");
  assert.equal(typeof releaseFirst, "function");
  assert.equal(policy.acquire("zapA"), null);
  assert.equal(policy.acquire("zapB"), null);
  releaseFirst();
  const releaseSecond = policy.acquire("zapA");
  assert.equal(typeof releaseSecond, "function");
  releaseSecond();
  now += 60000;
  assert.equal(policy.acquire("zapA"), null);
  assert.deepEqual(persisted.map((value) => value.calls), [1, 2]);
});

test("proxy token bucket refills only with elapsed time", () => {
  let now = Date.parse("2025-01-01T00:00:00Z");
  const policy = new ProxyPolicy({
    credentials: { zapA: "0123456789abcdef" },
    ratePerMinute: 1,
    perCredentialConcurrency: 1,
    globalConcurrency: 1,
    dailyBudget: 100,
    budget: { day: "2025-01-01", calls: 0 },
    persistBudget: () => {},
    now: () => now
  });
  const release = policy.acquire("zapA");
  release();
  assert.equal(policy.acquire("zapA"), null);
  now += 60000;
  assert.equal(typeof policy.acquire("zapA"), "function");
});