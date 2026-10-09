import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mkdtempSync, chmodSync, writeFileSync, utimesSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { CustomerApiClient, CustomerApiError, createCustomerApiAdmin, FileIntentStore, OPERATIONS, prepareCall, recoverAbandonedIntentLocks } from "../src/customer-api/index.mjs";

const KEY = "sr_live_test_key_0123456789abcdef";
const OPERATOR = "operator-token-for-tests-0123456789";
const spec = fileURLToPath(new URL("../../../artifacts/api-server/src/customer-api-openapi.json", import.meta.url));

function mockFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
    return handler(url, init, calls.length);
  };
  fn.calls = calls;
  return fn;
}
const ok = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "x-ratelimit-remaining": "41", ...headers } });

test("catalog covers every operation in the customer OpenAPI contract", { skip: !existsSync(spec) && "contract not present in this checkout" }, () => {
  const doc = JSON.parse(readFileSync(spec, "utf8"));
  const expected = [];
  for (const [path, item] of Object.entries(doc.paths)) for (const [method, op] of Object.entries(item)) expected.push(`${method.toUpperCase()} ${path} ${op.operationId}`);
  assert.equal(OPERATIONS.length, 49);
  assert.deepEqual(OPERATIONS.map((o) => `${o.method} ${o.path} ${o.id}`).sort(), expected.sort());
  assert.ok(OPERATIONS.some((o) => o.path.startsWith("/customer/paid-results")));
});

test("client exposes a method for every operation and uses the fixed HTTPS origin", async () => {
  const fetch = mockFetch(() => ok({ id: "acct" }));
  const client = new CustomerApiClient({ apiKey: KEY, fetch });
  for (const op of OPERATIONS) assert.equal(typeof client[op.id], "function", op.id);
  const r = await client.customerGetAccount();
  assert.equal(r.status, 200);
  assert.equal(r.rateLimit.remaining, 41);
  assert.equal(fetch.calls[0].url, "https://www.sendrepute.com/api/v1/account");
  assert.equal(fetch.calls[0].init.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(fetch.calls[0].init.redirect, "manual");
  assert.equal(JSON.stringify(client).includes(KEY), false);
});

test("client validates parameters, query bounds and body fields", async () => {
  const client = new CustomerApiClient({ apiKey: KEY, fetch: mockFetch(() => ok({})) });
  await assert.rejects(client.call("customerGetPaidResult", { params: { recoveryId: "../admin" } }), { code: "INVALID_PARAMETER" });
  await assert.rejects(client.call("customerGetCreditLedger", { query: { limit: 51 } }), { code: "INVALID_PARAMETER" });
  await assert.rejects(client.call("customerGetCreditLedger", { query: { host: "evil" } }), { code: "UNKNOWN_PARAMETER" });
  await assert.rejects(client.call("customerStandardBuilderCompile", { body: { mjml: "<mjml/>", url: "https://x" } }), { code: "UNKNOWN_FIELD" });
  await assert.rejects(client.call("customerStandardBuilderCompile", { body: { mjml: "x".repeat(600 * 1024) } }), { code: "BODY_TOO_LARGE" });
  await assert.rejects(client.call("getCustomerApiModels", { body: { a: 1 } }), { code: "UNEXPECTED_BODY" });
  const p = prepareCall("customerGetVipBuilderTemplate", { params: { templateId: "vip-07" } });
  assert.equal(p.path, "/v1/vip/email-builder/templates/vip-07");
  assert.throws(() => prepareCall("customerGetVipBuilderTemplate", { params: { templateId: "vip-21" } }), { code: "INVALID_PARAMETER" });
});

test("paid operations require consent, inject the consented price and refuse mismatches", async () => {
  const fetch = mockFetch(() => ok({ analysisId: "a" }));
  const client = new CustomerApiClient({ apiKey: KEY, fetch });
  const body = { analysisId: "run-1", metrics: { sent: 10 } };
  await assert.rejects(client.customerAnalyzeCampaignInsights({ body }), { code: "CONSENT_REQUIRED" });
  await client.customerAnalyzeCampaignInsights({ body }, { paidConsent: { acknowledged: true, expectedPriceMillicents: 10000 } });
  assert.equal(fetch.calls[0].body.expectedPriceMillicents, 10000);
  assert.equal(fetch.calls[0].body.consent, true);
  await assert.rejects(client.customerPurchaseVip({ body: { expectedPriceMillicents: 5 } }, { paidConsent: { acknowledged: true, expectedPriceMillicents: 6 } }), { code: "PRICE_MISMATCH" });
  await assert.rejects(client.classifyCustomerEmail({ body: { sender: "a@b.c", subject: "s", body: "b" } }, { paidConsent: { acknowledged: true, expectedPriceMillicents: 900 } }), { code: "CONSENT_REQUIRED" });
  await assert.rejects(client.customerCreateVipEmailTemplate({ body: { prompt: "p", imageUrls: ["https://evil.example/x.png"] } }, { paidConsent: { acknowledged: true, expectedPriceMillicents: 1 } }), { code: "URLS_REFUSED" });
  await assert.rejects(client.customerResolvePaidResult({ params: { recoveryId: "6f1c1c6e-8a4b-4c1e-9a7e-2b3c4d5e6f70" }, body: { action: "resolve", reason: "r" } }), { code: "CONFIRMATION_REQUIRED" });
  assert.equal(fetch.calls.length, 1);
});

test("transport failures are not retried; redirects, oversize and non-JSON are refused", async () => {
  const failing = mockFetch(() => { throw new Error("boom"); });
  const c1 = new CustomerApiClient({ apiKey: KEY, fetch: failing });
  await assert.rejects(c1.customerPurchaseVip({ body: { expectedPriceMillicents: 5 } }, { paidConsent: { acknowledged: true, expectedPriceMillicents: 5 } }), CustomerApiError);
  assert.equal(failing.calls.length, 1);
  const redirect = new CustomerApiClient({ apiKey: KEY, fetch: mockFetch(() => new Response(null, { status: 302, headers: { location: "https://evil" } })) });
  await assert.rejects(redirect.customerGetAccount(), { code: "TRANSPORT" });
  const big = new CustomerApiClient({ apiKey: KEY, maxResponseBytes: 1024, fetch: mockFetch(() => ok({ x: "y".repeat(5000) })) });
  await assert.rejects(big.customerGetAccount(), { code: "RESPONSE_TOO_LARGE" });
  const html = new CustomerApiClient({ apiKey: KEY, fetch: mockFetch(() => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } })) });
  await assert.rejects(html.customerGetAccount(), { code: "MALFORMED_RESPONSE" });
  const err = new CustomerApiClient({ apiKey: KEY, fetch: mockFetch(() => ok({ error: { code: "PRICE_CHANGED" } }, 409)) });
  const r = await err.customerPurchaseVip({ body: { expectedPriceMillicents: 5 } }, { paidConsent: { acknowledged: true, expectedPriceMillicents: 5 } });
  assert.equal(r.status, 409);
  assert.equal(r.ok, false);
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "sr-intents-"));
  chmodSync(dir, 0o700);
  return dir;
}
const tempStore = (dir = tempDir()) => new FileIntentStore({ directory: dir, singleHost: true });

async function login(base) {
  const r = await globalThis.fetch(`${base}/sendrepute-admin/session`, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ token: OPERATOR }) });
  const cookie = r.headers.get("set-cookie").split(";")[0];
  const { csrf } = await r.json();
  return async (payload) => {
    const res = await globalThis.fetch(`${base}/sendrepute-admin/call`, { method: "POST", headers: { cookie, origin: base, "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify(payload) });
    return { status: res.status, data: await res.json() };
  };
}

async function withAdmin(fetch, options, run) {
  const client = new CustomerApiClient({ apiKey: KEY, fetch });
  const admin = createCustomerApiAdmin({ client, operatorTokens: [OPERATOR], secureCookie: false, intentStore: tempStore(), ...options });
  const server = createServer(async (req, res) => { if (!(await admin(req, res))) { res.writeHead(404); res.end(); } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run(base); } finally { server.close(); }
}

test("admin console enforces operator auth, CSRF, quote-before-paid and never exposes the key", async () => {
  const fetch = mockFetch((url) => url.endsWith("/v1/campaign-insights/quote") ? ok({ priceMillicents: 10000 }) : ok({ analysisId: "run-1", summary: "<script>x</script>" }));
  await withAdmin(fetch, {}, async (base) => {
    const page = await (await globalThis.fetch(`${base}/sendrepute-admin`)).text();
    assert.ok(!page.includes(KEY) && !page.includes("__SR_"));
    const pageRes = await globalThis.fetch(`${base}/sendrepute-admin`);
    const csp = pageRes.headers.get("content-security-policy");
    assert.match(csp, /script-src 'nonce-/);
    assert.match(csp, /style-src 'unsafe-inline'/, "email inline styles render in the sandboxed preview");
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /img-src data:;/, "external image and font requests stay blocked");
    assert.equal((await globalThis.fetch(`${base}/sendrepute-admin/catalog`)).status, 401);
    const origin = base;
    const bad = await globalThis.fetch(`${base}/sendrepute-admin/session`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ token: "wrong" }) });
    assert.equal(bad.status, 401);
    const cross = await globalThis.fetch(`${base}/sendrepute-admin/session`, { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: JSON.stringify({ token: OPERATOR }) });
    assert.equal(cross.status, 403);
    const login = await globalThis.fetch(`${base}/sendrepute-admin/session`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ token: OPERATOR }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    assert.match(login.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
    const { csrf } = await login.json();
    const cat = await (await globalThis.fetch(`${base}/sendrepute-admin/catalog`, { headers: { cookie } })).json();
    assert.equal(cat.operations.length, 49);
    assert.equal(cat.operations.find((o) => o.id === "customerCreateHostedBuilderHandoff").enabled, false);
    assert.ok(!JSON.stringify(cat).includes(KEY));
    const call = (payload, headers = {}) => globalThis.fetch(`${base}/sendrepute-admin/call`, { method: "POST", headers: { cookie, origin, "content-type": "application/json", "x-csrf-token": csrf, ...headers }, body: JSON.stringify(payload) });
    assert.equal((await call({ operationId: "customerGetAccount" }, { "x-csrf-token": "nope" })).status, 403);
    const analyze = { operationId: "customerAnalyzeCampaignInsights", body: { analysisId: "run-1", metrics: {} }, paidConsent: { acknowledged: true, expectedPriceMillicents: 10000 } };
    const early = await call(analyze);
    assert.equal(early.status, 428);
    assert.equal((await early.json()).error.code, "QUOTE_REQUIRED");
    const quote = await (await call({ operationId: "customerQuoteCampaignInsights", body: {} })).json();
    assert.equal(quote.quoteRecorded.priceMillicents, 10000);
    const paid = await call(analyze);
    assert.equal(paid.status, 200);
    const out = await paid.json();
    assert.equal(out.upstream.data.summary, "<script>x</script>");
    assert.equal(fetch.calls.at(-1).body.consent, true);
    assert.equal((await call(analyze)).status, 428, "quote is consumed; no repeat charge without re-quote");
    assert.equal((await call({ operationId: "customerCreateHostedBuilderHandoff", body: { state: "s", returnOrigin: "https://evil.example" } })).status, 403);
    assert.equal(fetch.calls.length, 2);
    for (const c of fetch.calls) assert.ok(c.url.startsWith("https://www.sendrepute.com/api/"));
  });
});

test("hosted handoff uses only the configured return origin", async () => {
  const fetch = mockFetch(() => ok({ url: "https://www.sendrepute.com/x" }, 201));
  await withAdmin(fetch, { handoffReturnOrigin: "https://campaigns.example.com" }, async (base) => {
    const login = await globalThis.fetch(`${base}/sendrepute-admin/session`, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ token: OPERATOR }) });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const { csrf } = await login.json();
    const call = (body) => globalThis.fetch(`${base}/sendrepute-admin/call`, { method: "POST", headers: { cookie, origin: base, "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify({ operationId: "customerCreateHostedBuilderHandoff", body }) });
    assert.equal((await call({ state: "abc", returnOrigin: "https://evil.example" })).status, 400);
    assert.equal((await call({ state: "abc" })).status, 200);
    assert.equal(fetch.calls[0].body.returnOrigin, "https://campaigns.example.com");
  });
});

const ACCESS = { operationId: "customerCreateVipEmailBuilderAccess", body: { designId: "design-1", sourceKind: "template", templateId: "vip-01" }, paidConsent: { acknowledged: true, expectedPriceMillicents: 2500 } };
const PRICING = { operationId: "customerGetPricingSettings" };

test("paid operations are refused without a durable intent store (default deny)", async () => {
  const fetch = mockFetch(() => ok({ expectedPriceMillicents: 2500 }));
  await withAdmin(fetch, { intentStore: null }, async (base) => {
    const call = await login(base);
    await call(PRICING);
    const r = await call(ACCESS);
    assert.equal(r.status, 503);
    assert.equal(r.data.error.code, "INTENT_STORE_REQUIRED");
    assert.equal(fetch.calls.length, 1);
  });
});

test("ambiguous paid failure stays locked across sessions and restart; release preserves replay identity", async () => {
  const dir = tempDir();
  let mode = "fail";
  const fetch = mockFetch((url) => {
    if (url.endsWith("/v1/pricing")) return ok({ expectedPriceMillicents: 2500 });
    if (mode === "fail") throw new Error("socket hang up");
    return ok({ accessId: "acc-1", billing: { chargedMillicents: 2500 } }, 201);
  });
  const paidCalls = () => fetch.calls.filter((c) => c.url.endsWith("/v1/vip/email-builder/access"));
  await withAdmin(fetch, { intentStore: tempStore(dir) }, async (base) => {
    const a = await login(base);
    const b = await login(base);
    await a(PRICING);
    const first = await a(ACCESS);
    assert.equal(first.status, 502);
    assert.equal(first.data.error.code, "UPSTREAM_AMBIGUOUS");
    assert.equal(first.data.error.intent.state, "ambiguous");
    const replayId = first.data.error.intent.replayId;
    assert.match(replayId, /^[0-9a-f-]{36}$/);
    assert.equal(paidCalls()[0].body.recoveryId, replayId, "replay identity persisted before sending");
    await b(PRICING);
    const second = await b(ACCESS);
    assert.equal(second.status, 409);
    assert.equal(second.data.error.code, "INTENT_LOCKED");
    assert.equal(paidCalls().length, 1);
  });
  // Process restart: new admin, new store object, same directory.
  await withAdmin(fetch, { intentStore: tempStore(dir) }, async (base) => {
    const c = await login(base);
    await c(PRICING);
    const locked = await c(ACCESS);
    assert.equal(locked.data.error.code, "INTENT_LOCKED");
    const list = await c({ operationId: "sendrepute.listIntents" });
    assert.equal(list.data.intents.length, 1);
    const key = list.data.intents[0].key;
    const replayId = list.data.intents[0].replayId;
    assert.equal((await c({ operationId: "sendrepute.releaseIntent", intentKey: key, reason: "ledger shows no charge" })).status, 428);
    const rel = await c({ operationId: "sendrepute.releaseIntent", intentKey: key, reason: "ledger shows no charge", confirm: true });
    assert.equal(rel.data.intent.state, "released");
    mode = "ok";
    await c(PRICING);
    const done = await c(ACCESS);
    assert.equal(done.status, 200);
    assert.equal(done.data.intent.state, "completed");
    assert.equal(paidCalls().at(-1).body.recoveryId, replayId, "resend after release reuses the upstream replay id");
    await c(PRICING);
    const dup = await c(ACCESS);
    assert.equal(dup.data.error.code, "INTENT_COMPLETED");
    await c({ operationId: "sendrepute.releaseIntent", intentKey: key, reason: "second purchase intended", confirm: true });
    await c(PRICING);
    const again = await c(ACCESS);
    assert.equal(again.status, 200);
    assert.notEqual(paidCalls().at(-1).body.recoveryId, replayId, "a deliberate second charge gets a fresh replay id");
    assert.equal(paidCalls().length, 3);
  });
});

test("definitive refusals release the intent; price above consent is flagged", async () => {
  let status = 409;
  const fetch = mockFetch((url) => url.endsWith("/v1/pricing") ? ok({ expectedPriceMillicents: 2500 }) : ok(status === 409 ? { error: { code: "PRICE_CHANGED" } } : { accessId: "a", billing: { chargedMillicents: 9999 } }, status));
  await withAdmin(fetch, {}, async (base) => {
    const call = await login(base);
    await call(PRICING);
    const refused = await call(ACCESS);
    assert.equal(refused.data.intent.state, "failed");
    status = 201;
    await call(PRICING);
    const ok2 = await call(ACCESS);
    assert.equal(ok2.data.intent.state, "completed");
    assert.deepEqual(ok2.data.priceAlert, { chargedMillicents: 9999, consentedMillicents: 2500 });
  });
});

test("file intent store refuses unsupported configuration and is atomic across processes", async () => {
  assert.throws(() => new FileIntentStore({ directory: tempDir() }), /single host/);
  assert.throws(() => new FileIntentStore({ directory: "relative/dir", singleHost: true }), /absolute/);
  const open = tempDir();
  chmodSync(open, 0o755);
  assert.throws(() => new FileIntentStore({ directory: open, singleHost: true }), /700/);
  const dir = tempDir();
  const storeUrl = new URL("../src/customer-api/intent-store.mjs", import.meta.url).href;
  const key = "a".repeat(64);
  const script = `import { FileIntentStore } from ${JSON.stringify(storeUrl)};
const s = new FileIntentStore({ directory: ${JSON.stringify(dir)}, singleHost: true });
const r = s.begin(${JSON.stringify(key)}, { fingerprint: "f", operationId: "customerPurchaseVip", replayField: null, replayId: null }, 1);
process.stdout.write(r.acquired ? "1" : "0");`;
  const runs = await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script]);
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(out) : reject(new Error(`child exited ${code}`)));
  })));
  assert.equal(runs.filter((r) => r === "1").length, 1, "exactly one worker acquires the intent");
  assert.equal(tempStore(dir).list("f")[0].state, "pending");
});

const RATES = { classificationBaseMillicents: 300, includedUniqueTerms: 5, additionalTermMillicents: 40, maximumClassificationMillicents: 2000 };
const PRICING_RESPONSE = (r) => ({ ...r, classificationBaseCents: 0.3, additionalTermCents: 0.04, maximumClassificationCents: 2, maximumTermsThreshold: 50, editTermCents: 0, editTermMillicents: 0, removeAllMillicents: 0, aiMinimumPerUniqueTermMillicents: 0 });
const EMAIL = { sender: "Ops Team", subject: "Renewal", body: "Your plan renews Friday." };

test("generic client sends the exact classification price authorization", async () => {
  const fetch = mockFetch(() => ok({ requestId: "r" }));
  const client = new CustomerApiClient({ apiKey: KEY, fetch });
  await client.classifyCustomerEmail({ body: { ...EMAIL } }, { paidConsent: { acknowledged: true, expectedPricing: RATES, maxChargeMillicents: 1200 } });
  assert.deepEqual(fetch.calls[0].body.priceAuthorization, { expectedPricing: RATES, maxChargeMillicents: 1200 });
  await assert.rejects(client.classifyCustomerEmail({ body: { ...EMAIL } }, { paidConsent: { acknowledged: true, expectedPricing: { ...RATES, extra: 1 }, maxChargeMillicents: 1 } }), { code: "CONSENT_REQUIRED" });
  await assert.rejects(client.classifyCustomerEmail({ body: { ...EMAIL, priceAuthorization: { expectedPricing: { ...RATES, additionalTermMillicents: 41 }, maxChargeMillicents: 1200 } } }, { paidConsent: { acknowledged: true, expectedPricing: RATES, maxChargeMillicents: 1200 } }), { code: "PRICE_MISMATCH" });
  // Legacy form: a complete body authorization whose ceiling equals expectedPriceMillicents.
  await client.classifyCustomerEmail({ body: { ...EMAIL, priceAuthorization: { expectedPricing: RATES, maxChargeMillicents: 900 } } }, { paidConsent: { acknowledged: true, expectedPriceMillicents: 900 } });
  assert.deepEqual(fetch.calls[1].body.priceAuthorization, { expectedPricing: RATES, maxChargeMillicents: 900 });
  assert.equal(fetch.calls.length, 2);
});

test("console classification authorizes the full server rate schedule, rejects stale confirmation and maps PRICE_CHANGED", async () => {
  let rates = RATES;
  let classifyStatus = 200;
  const fetch = mockFetch((url) => url.endsWith("/v1/pricing") ? ok(PRICING_RESPONSE(rates))
    : classifyStatus === 200 ? ok({ requestId: "req-1", billing: { chargedMillicents: 340 } }) : ok({ error: { code: "PRICE_CHANGED" } }, classifyStatus));
  const classifies = () => fetch.calls.filter((c) => c.url.endsWith("/v1/classify"));
  await withAdmin(fetch, {}, async (base) => {
    const call = await login(base);
    const consent = (r, max) => ({ operationId: "classifyCustomerEmail", body: { ...EMAIL }, paidConsent: { acknowledged: true, expectedPricing: r, maxChargeMillicents: max } });
    assert.equal((await call(consent(RATES, 1500))).data.error.code, "QUOTE_REQUIRED");
    const q = await call({ operationId: "customerGetPricingSettings" });
    assert.deepEqual(q.data.quoteRecorded.pricing, RATES);
    const done = await call(consent(RATES, 1500));
    assert.equal(done.status, 200);
    assert.deepEqual(classifies()[0].body.priceAuthorization, { expectedPricing: RATES, maxChargeMillicents: 1500 }, "exact outbound authorization");
    assert.equal(done.data.intent.state, "completed");

    // Price changes after the operator confirmed: the stale schedule is refused before any charge.
    rates = { ...RATES, additionalTermMillicents: 55 };
    await call({ operationId: "customerGetPricingSettings" });
    const stale = await call(consent(RATES, 1600));
    assert.equal(stale.status, 409);
    assert.equal(stale.data.error.code, "PRICE_CONFIRMATION_STALE");
    assert.equal(classifies().length, 1);
    const fresh = await call(consent(rates, 1600));
    assert.equal(fresh.status, 200);
    assert.deepEqual(classifies()[1].body.priceAuthorization, { expectedPricing: rates, maxChargeMillicents: 1600 });

    // Server-side settlement refusal (price changed during inference) is definitive and needs a new quote.
    classifyStatus = 409;
    await call({ operationId: "customerGetPricingSettings" });
    const changed = await call(consent(rates, 1700));
    assert.equal(changed.data.upstream.status, 409);
    assert.equal(changed.data.intent.state, "failed");
    assert.equal((await call(consent(rates, 1700))).data.error.code, "QUOTE_REQUIRED");
    assert.equal(classifies().length, 3);
  });
});

test("stalled lock owner is never taken over; abandoned locks need offline recovery", async () => {
  const dir = tempDir();
  const key = "d".repeat(64);
  // A stalled owner holds the lock far beyond any former takeover window.
  writeFileSync(join(dir, `${key}.lock`), "99999 0", { mode: 0o600 });
  const old = new Date(Date.now() - 10 * 60 * 1000);
  utimesSync(join(dir, `${key}.lock`), old, old);
  const store = new FileIntentStore({ directory: dir, singleHost: true, lockWaitMs: 60 });
  assert.throws(() => store.begin(key, { fingerprint: "f", operationId: "customerPurchaseVip" }, 1), { code: "INTENT_STORE_BUSY" });
  assert.deepEqual(store.list("f"), [], "nothing admitted while the owner holds the lock");

  // Live stalled owner in another process: holds the lock while parent and siblings try to admit.
  const storeUrl = new URL("../src/customer-api/intent-store.mjs", import.meta.url).href;
  const live = "e".repeat(64);
  const owner = spawn(process.execPath, ["--input-type=module", "-e", `import { openSync, closeSync, unlinkSync, writeFileSync } from "node:fs";
const p = ${JSON.stringify(join(dir, live + ".lock"))}; closeSync(openSync(p, "wx", 0o600)); process.stdout.write("held");
setTimeout(() => { writeFileSync(${JSON.stringify(join(dir, live + ".json"))}, JSON.stringify({ key: ${JSON.stringify(live)}, fingerprint: "f", operationId: "customerPurchaseVip", state: "pending", replayId: null, createdAt: 1, updatedAt: 1, attempts: 1 }), { mode: 0o600 }); unlinkSync(p); }, 700);`]);
  await new Promise((r) => owner.stdout.once("data", r));
  const contenders = await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve) => {
    const c = spawn(process.execPath, ["--input-type=module", "-e", `import { FileIntentStore } from ${JSON.stringify(storeUrl)};
try { const r = new FileIntentStore({ directory: ${JSON.stringify(dir)}, singleHost: true, lockWaitMs: 150 }).begin(${JSON.stringify(live)}, { fingerprint: "f", operationId: "customerPurchaseVip" }, 2); process.stdout.write(r.acquired ? "1" : "0"); } catch (e) { process.stdout.write(e.code); }`]);
    let out = ""; c.stdout.on("data", (d) => { out += d; }); c.on("close", () => resolve(out));
  })));
  assert.deepEqual(contenders, ["INTENT_STORE_BUSY", "INTENT_STORE_BUSY", "INTENT_STORE_BUSY", "INTENT_STORE_BUSY"]);
  await new Promise((r) => owner.on("close", r));
  const after = new FileIntentStore({ directory: dir, singleHost: true }).begin(live, { fingerprint: "f", operationId: "customerPurchaseVip" }, 3);
  assert.equal(after.acquired, false, "the owner's pending intent still blocks after it finishes");

  // Pending intents cannot be released online, even when old.
  assert.throws(() => store.release(live, "f", "try", 999999), { code: "INTENT_IN_PROGRESS" });
  assert.throws(() => recoverAbandonedIntentLocks({ directory: dir }), /allWorkersStopped/);
  const rec = recoverAbandonedIntentLocks({ directory: dir, allWorkersStopped: true });
  assert.deepEqual(rec.removedLocks, [`${key}.lock`]);
  assert.ok(rec.pendingMadeAmbiguous.includes(live));
  assert.ok(!readdirSync(dir).some((n) => n.endsWith(".lock")));
  assert.equal(store.begin(key, { fingerprint: "f", operationId: "customerPurchaseVip" }, 4).acquired, true);
  assert.equal(store.release(live, "f", "reconciled after recovery", 5).state, "released");
});
