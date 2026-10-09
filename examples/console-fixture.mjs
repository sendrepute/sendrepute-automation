// Browser fixture for ONE local UI verification pass of the operator console.
//
// * No upstream network: the client gets an in-process fake transport and
//   globalThis.fetch is replaced with a function that throws.
// * Disposable credentials: a random fake API key and a random operator token
//   generated at start-up (printed once). Never use a real SendRepute key here.
// * Throwaway intent ledger in a fresh 0700 temp directory.
//
// Run: node examples/console-fixture.mjs   (then open the printed URL)
// Scenarios:
//   customerGetPricingSettings     -> rate schedule (changes on every 3rd call to exercise stale confirmation)
//   classifyCustomerEmail          -> charged receipt; outbound priceAuthorization is logged to stdout
//   customerCreateVipEmailBuilderAccess -> first attempt ambiguous (simulated network reset), then success
//   customerGetStandardBuilderTemplate  -> HTML with inline <style> and style="" for the preview CSP check
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileIntentStore, startCustomerApiConsole } from "../src/customer-api/index.mjs";

globalThis.fetch = () => { throw new Error("Network disabled in the console fixture"); };

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "x-ratelimit-limit": "120", "x-ratelimit-remaining": "117" } });
let pricingCalls = 0;
let accessCalls = 0;
const ratesFor = (n) => ({ classificationBaseMillicents: 300, includedUniqueTerms: 5, additionalTermMillicents: n % 3 === 0 ? 55 : 40, maximumClassificationMillicents: 2000 });
const EMAIL_HTML = `<!doctype html><html><head><style>body{margin:0;background:#f4efe6;font-family:Georgia,serif}.card{max-width:520px;margin:32px auto;background:#fffdf8;border:1px solid #d9cfbd;border-radius:10px;padding:28px}h1{color:#7a2e1f;font-size:26px}</style></head><body><div class="card"><h1>Fixture renewal notice</h1><p style="color:#3c5a4a;font-size:16px;line-height:1.6">If this paragraph is green and the card has a cream background, inline email styles render in the sandboxed preview.</p><img src="https://example.invalid/tracker.png" alt="external image must stay blocked"><script>document.body.innerHTML='SCRIPT RAN - CSP FAILURE'</script></div></body></html>`;

async function fakeFetch(url, init = {}) {
  const path = new URL(url).pathname.replace(/^\/api/, "");
  const body = init.body ? JSON.parse(init.body) : undefined;
  console.log(`[fixture upstream] ${init.method || "GET"} ${path}${body && body.priceAuthorization ? ` priceAuthorization=${JSON.stringify(body.priceAuthorization)}` : ""}`);
  if (path === "/v1/pricing") {
    pricingCalls += 1;
    const r = ratesFor(pricingCalls);
    return json({ ...r, classificationBaseCents: 0.3, additionalTermCents: r.additionalTermMillicents / 1000, maximumClassificationCents: 2, maximumTermsThreshold: 50, editTermCents: 0.1, editTermMillicents: 100, removeAllMillicents: 500, aiMinimumPerUniqueTermMillicents: 25 });
  }
  if (path === "/v1/classify") return json({ requestId: "fixture_req_" + randomBytes(6).toString("hex"), spamProbability: 0.183, flaggedTerms: ["renews"], billing: { chargedMillicents: 340 } });
  if (path === "/v1/vip/email-builder/access") {
    accessCalls += 1;
    if (accessCalls === 1) throw new TypeError("fetch failed (simulated connection reset)");
    return json({ accessId: "fixture_access_1", billing: { chargedMillicents: 2500 } }, 201);
  }
  if (path.startsWith("/v1/email-builder/templates/")) return json({ templateId: path.split("/").pop(), filename: "fixture-email.html", html: EMAIL_HTML });
  if (path === "/v1/account") return json({ id: "acct_fixture", email: "operator@fixture.invalid", balanceMillicents: 48210 });
  return json({ fixture: true, path, note: "Generic fixture response; no upstream call was made." });
}

const dir = mkdtempSync(join(tmpdir(), "sr-fixture-intents-"));
chmodSync(dir, 0o700);
const operatorToken = process.env.FIXTURE_OPERATOR_TOKEN && process.env.FIXTURE_OPERATOR_TOKEN.length >= 24 ? process.env.FIXTURE_OPERATOR_TOKEN : randomBytes(24).toString("base64url");
const server = await startCustomerApiConsole({
  apiKey: "sr_fixture_" + randomBytes(16).toString("hex"),
  operatorToken,
  port: Number(process.env.PORT || process.env.SENDREPUTE_CONSOLE_PORT || 8787),
  product: "SendRepute console fixture (fake transport)",
  handoffReturnOrigin: "https://fixture.invalid",
  intentStore: new FileIntentStore({ directory: dir, singleHost: true }),
  fetch: fakeFetch
});
const { address, port } = server.address();
console.log(`Console fixture: http://${address}:${port}/sendrepute-admin`);
console.log(`Disposable operator token: ${operatorToken}`);
console.log(`Throwaway intent ledger: ${dir}`);
