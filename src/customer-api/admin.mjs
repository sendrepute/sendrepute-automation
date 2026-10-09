import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { API_VERSION, OPERATIONS, QUOTE_OPERATIONS } from "./catalog.mjs";
import { PolicyError, prepareCall, extractQuotedPrice, classificationRates, CLASSIFY_OPERATION } from "./policy.mjs";
import { CustomerApiError } from "./client.mjs";
import { IntentConflict, intentKey, newReplayId, replayFieldFor } from "./intent-store.mjs";

const TEMPLATE = readFileSync(new URL("./admin-ui.html", import.meta.url), "utf8");
const MAX_ADMIN_BODY = 640 * 1024;
const ORIGIN = /^https:\/\/[a-z0-9.-]{1,253}(?::\d{1,5})?$/;

const digest = (v) => createHash("sha256").update(String(v)).digest();
const same = (a, b) => typeof a === "string" && typeof b === "string" && timingSafeEqual(digest(a), digest(b));
const escapeAttr = (v) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function json(res, status, value, extra = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", ...extra });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > MAX_ADMIN_BODY) { reject(new PolicyError(413, "BODY_TOO_LARGE", "Console request too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function publicIntent(r) {
  if (!r) return undefined;
  return { key: r.key, operationId: r.operationId, state: r.state, replayField: r.replayField, replayId: r.replayId, createdAt: r.createdAt, updatedAt: r.updatedAt, attempts: r.attempts, httpStatus: r.httpStatus, note: r.note };
}

function findInt(data, name, depth = 0) {
  if (!data || typeof data !== "object" || depth > 4) return null;
  if (Number.isInteger(data[name])) return data[name];
  for (const v of Object.values(data)) { const f = findInt(v, name, depth + 1); if (f !== null) return f; }
  return null;
}

/**
 * Operator-only, CSRF-protected admin console for the full customer API.
 * The browser never receives the SendRepute key; it only talks to this handler.
 */
export function createCustomerApiAdmin({
  client,
  operatorTokens,
  basePath = "/sendrepute-admin",
  product = "SendRepute integration",
  handoffReturnOrigin = null,
  enabledOperations = null,
  secureCookie = true,
  sessionTtlMs = 30 * 60 * 1000,
  intentStore = null,
  now = () => Date.now()
} = {}) {
  if (!client || typeof client.send !== "function") throw new TypeError("client must be a CustomerApiClient");
  const tokens = (Array.isArray(operatorTokens) ? operatorTokens : [operatorTokens]).filter((t) => typeof t === "string");
  if (tokens.length === 0 || tokens.some((t) => t.length < 24)) throw new TypeError("operatorTokens must contain secrets of at least 24 characters");
  if (!/^\/[A-Za-z0-9/_-]{1,80}$/.test(basePath) || basePath.endsWith("/")) throw new TypeError("basePath is invalid");
  if (handoffReturnOrigin !== null && !ORIGIN.test(handoffReturnOrigin)) throw new TypeError("handoffReturnOrigin must be an exact https origin");
  const enabled = new Set(enabledOperations || OPERATIONS.map((o) => o.id));
  if (!handoffReturnOrigin) enabled.delete("customerCreateHostedBuilderHandoff");
  if (intentStore !== null && (typeof intentStore.begin !== "function" || typeof intentStore.finish !== "function")) throw new TypeError("intentStore must be an intent ledger such as FileIntentStore");
  if (typeof client.credentialFingerprint !== "function") throw new TypeError("client must expose credentialFingerprint()");
  const fingerprint = client.credentialFingerprint();
  const sessions = new Map();
  const cookieName = "sr_console";
  const cookieAttrs = `Path=${basePath}; HttpOnly; SameSite=Strict${secureCookie ? "; Secure" : ""}`;

  function session(req) {
    const sid = cookies(req)[cookieName];
    if (!sid || !/^[A-Za-z0-9_-]{43}$/.test(sid)) return null;
    const s = sessions.get(sid);
    if (!s || s.expires < now()) { sessions.delete(sid); return null; }
    s.expires = now() + sessionTtlMs;
    return s;
  }

  function requireStore() {
    if (!intentStore) throw new PolicyError(503, "INTENT_STORE_REQUIRED", "Paid and billing operations are disabled until a durable intent store is configured");
  }

  function safeFinish(key, state, status, nowSec) {
    try { return intentStore.finish(key, state, status, nowSec); } catch { return null; }
  }

  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return false;
    try { return new URL(origin).host === req.headers.host; } catch { return false; }
  }

  function catalog() {
    return OPERATIONS.map((o) => ({
      ...o,
      enabled: enabled.has(o.id),
      disabledReason: enabled.has(o.id) ? undefined : (o.handoff && !handoffReturnOrigin ? "Configure handoffReturnOrigin to enable hosted builder handoffs." : "Disabled by server configuration.")
    }));
  }

  return async function handle(req, res) {
    const url = new URL(req.url, "http://console.invalid");
    if (url.pathname !== basePath && !url.pathname.startsWith(basePath + "/")) return false;
    const route = url.pathname.slice(basePath.length) || "/";
    try {
      if (req.method === "GET" && (route === "/" || route === "")) {
        const nonce = randomBytes(18).toString("base64");
        const html = TEMPLATE.replaceAll("__SR_NONCE__", nonce).replace("__SR_BASE__", escapeAttr(basePath)).replace("__SR_CSRF__", "")
          .replace("__SR_LOGIN__", "1").replace("__SR_PRODUCT__", escapeAttr(product));
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; frame-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
          "X-Frame-Options": "DENY"
        });
        res.end(html);
        return true;
      }
      if (req.method === "POST" && route === "/session") {
        if (!sameOrigin(req)) return json(res, 403, { error: { code: "ORIGIN_REFUSED", message: "Cross-origin sign-in refused" } }), true;
        let parsed;
        try { parsed = JSON.parse(await readBody(req)); } catch (e) { if (e instanceof PolicyError) throw e; parsed = null; }
        const token = parsed && typeof parsed.token === "string" ? parsed.token : "";
        if (!tokens.some((t) => same(t, token))) return json(res, 401, { error: { code: "OPERATOR_REFUSED", message: "Operator token refused" } }), true;
        const sid = randomBytes(32).toString("base64url");
        const csrf = randomBytes(32).toString("base64url");
        sessions.set(sid, { csrf, expires: now() + sessionTtlMs, quotes: {}, pricing: null, inflight: false });
        return json(res, 200, { csrf }, { "Set-Cookie": `${cookieName}=${sid}; ${cookieAttrs}; Max-Age=${Math.floor(sessionTtlMs / 1000)}` }), true;
      }
      const s = session(req);
      if (!s) return json(res, 401, { error: { code: "OPERATOR_REQUIRED", message: "Operator session required" } }), true;
      if (req.method === "GET" && route === "/catalog") {
        return json(res, 200, { product, apiVersion: API_VERSION, csrf: s.csrf, operations: catalog() }), true;
      }
      if (req.method === "POST" && route === "/call") {
        if (!sameOrigin(req) || !same(s.csrf, req.headers["x-csrf-token"])) return json(res, 403, { error: { code: "CSRF_REFUSED", message: "CSRF validation failed" } }), true;
        if (!/^application\/json\b/i.test(req.headers["content-type"] || "")) return json(res, 415, { error: { code: "JSON_REQUIRED", message: "JSON body required" } }), true;
        let payload;
        try { payload = JSON.parse(await readBody(req)); } catch (e) { if (e instanceof PolicyError) throw e; throw new PolicyError(400, "INVALID_JSON", "Console request is not valid JSON"); }
        if (!payload || typeof payload !== "object") throw new PolicyError(400, "INVALID_JSON", "Console request must be an object");
        const nowSec = Math.floor(now() / 1000);
        if (payload.operationId === "sendrepute.listIntents") {
          requireStore();
          return json(res, 200, { intents: intentStore.list(fingerprint).map(publicIntent) }), true;
        }
        if (payload.operationId === "sendrepute.releaseIntent") {
          requireStore();
          if (payload.confirm !== true) throw new PolicyError(428, "CONFIRMATION_REQUIRED", "Releasing an intent requires explicit confirmation");
          if (typeof payload.intentKey !== "string" || !/^[a-f0-9]{64}$/.test(payload.intentKey)) throw new PolicyError(400, "INVALID_PARAMETER", "intentKey is invalid");
          if (typeof payload.reason !== "string" || payload.reason.trim().length < 3 || payload.reason.length > 200) throw new PolicyError(400, "INVALID_PARAMETER", "Give a reason of 3-200 characters");
          return json(res, 200, { intent: publicIntent(intentStore.release(payload.intentKey, fingerprint, payload.reason.trim(), nowSec)) }), true;
        }
        const op = OPERATIONS.find((o) => o.id === payload.operationId);
        const prepared = prepareCall(payload.operationId, { params: payload.params, query: payload.query, body: payload.body }, {
          enabled, paidConsent: payload.paidConsent, confirm: payload.confirm, requireQuote: true,
          quotedAt: op && op.quote ? s.quotes[op.quote] : null, now: now(), handoffReturnOrigin,
          ...(payload.operationId === CLASSIFY_OPERATION ? { expectedPricing: s.pricing || null } : {})
        });
        const guarded = prepared.op.paid || prepared.op.financial;
        if (!guarded) {
          const upstream = await client.send(prepared);
          let quoteRecorded;
          if (QUOTE_OPERATIONS.has(prepared.op.id) && upstream.ok) {
            s.quotes[prepared.op.id] = now();
            quoteRecorded = { priceMillicents: extractQuotedPrice(upstream.data) };
            if (prepared.op.id === "customerGetPricingSettings") {
              // Server-returned rate schedule; classification consent must match it exactly.
              s.pricing = classificationRates(upstream.data);
              quoteRecorded.pricing = s.pricing;
            }
          }
          return json(res, 200, { upstream, quoteRecorded }), true;
        }
        requireStore();
        if (s.inflight) throw new PolicyError(409, "PAID_IN_FLIGHT", "Another paid or billing operation is still running in this session");
        const body = prepared.body === undefined ? undefined : JSON.parse(prepared.body);
        const key = intentKey(fingerprint, prepared, body);
        const replayField = replayFieldFor(prepared.op);
        const supplied = replayField && body && typeof body[replayField] === "string" && body[replayField] !== "" ? body[replayField] : null;
        // Persist the intent (and the upstream replay identity) BEFORE anything is sent.
        const begun = intentStore.begin(key, { fingerprint, operationId: prepared.op.id, replayField, replayId: supplied || newReplayId(replayField) }, nowSec);
        if (!begun.acquired) {
          const rec = begun.record;
          const code = rec.state === "completed" ? "INTENT_COMPLETED" : "INTENT_LOCKED";
          const message = rec.state === "completed"
            ? "An identical paid request already completed. Release it deliberately to run a second, separate charge."
            : rec.state === "ambiguous"
              ? "An identical paid request has an unknown outcome. Reconcile it (ledger or paid-result recovery) and release it before resending."
              : "An identical paid request is in progress in another session or worker.";
          throw new IntentConflict(409, code, message, rec);
        }
        if (replayField && !supplied && begun.record.replayId) {
          body[replayField] = begun.record.replayId;
          prepared.body = JSON.stringify(body);
        }
        if (prepared.op.paid && op.quote) delete s.quotes[op.quote];
        if (prepared.op.id === CLASSIFY_OPERATION) s.pricing = null;
        s.inflight = true;
        let upstream;
        try {
          upstream = await client.send(prepared);
        } catch (error) {
          const rec = safeFinish(key, "ambiguous", null, nowSec) || begun.record;
          throw new IntentConflict(502, "UPSTREAM_AMBIGUOUS", `Outcome unknown (${error && error.code ? error.code : "transport"}). Nothing was retried; the intent stays locked until reconciled.`, rec);
        } finally {
          s.inflight = false;
        }
        const st = upstream.status;
        const state = upstream.ok ? "completed" : (st >= 400 && st < 500 && st !== 408 && st !== 425) ? "failed" : "ambiguous";
        const rec = safeFinish(key, state, st, Math.floor(now() / 1000)) || { ...begun.record, state: "pending" };
        const charged = findInt(upstream.data, "chargedMillicents");
        const pc = payload.paidConsent || {};
        const consented = Number.isInteger(pc.maxChargeMillicents) ? pc.maxChargeMillicents : Number.isInteger(pc.expectedPriceMillicents) ? pc.expectedPriceMillicents : null;
        const priceAlert = charged !== null && consented !== null && charged > consented ? { chargedMillicents: charged, consentedMillicents: consented } : undefined;
        return json(res, 200, { upstream, intent: publicIntent(rec), priceAlert }), true;
      }
      return json(res, 404, { error: { code: "NOT_FOUND", message: "Unknown console route" } }), true;
    } catch (error) {
      if (error instanceof IntentConflict) return json(res, error.status, { error: { code: error.code, message: error.message, intent: error.record ? publicIntent(error.record) : undefined } }), true;
      if (error instanceof PolicyError) return json(res, error.status, { error: { code: error.code, message: error.message } }), true;
      if (error instanceof CustomerApiError) return json(res, 502, { error: { code: error.code, message: error.message } }), true;
      return json(res, 500, { error: { code: "INTERNAL", message: "Console request failed" } }), true;
    }
  };
}
