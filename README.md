# SendRepute paid draft-analysis recipes

Version 0.2.0 contains honest, standalone advisory analysis recipes for Zapier
and Make. Each submits three owner-selected strings to the paid API and displays
the result. Neither recipe is a send adapter, deliverability approval, whole
message classifier, allow/block mechanism, or failure-preserving mail route.

There is no claimed SendRepute Zapier/Make app, marketplace approval, or
unverified import artifact. Follow the exact native-module guides in
`zapier/README.md` and `make/README.md`.

## Public contract

The paid endpoint is one non-retried
`POST https://www.sendrepute.com/api/v1/classify` with JSON `sender` (display
name), `subject`, and `body`. A 200 response contains nested `requestId`,
`model`, `result`, and `billing`. Classification is advisory and does not
guarantee inbox placement.

`examples/classify-response.schema.json` is generated-equivalent to the complete
transitive response schemas in the repository OpenAPI contract, including
unknown-property rejection. The Zapier display validator enforces that complete
shape. The Make guide labels its native filter as only a display guard.

## Consent and credentials

Both guides implement false-by-default paid gates before HTTP. Zapier's gate is
two compile-time false constants in the exact Code source. Make uses persisted
boolean false literals in Tools and an AND filter.

Make stores the bearer token in the HTTP app secure keychain. Zapier Webhooks
has no SendRepute credential connection, so the Zapier recipe requires an
owner-controlled HTTPS proxy; the SendRepute token must never enter the Zap.
The guide documents Zap editor/history visibility rather than calling a manual
header private. A runnable bounded loopback proxy is included as
`examples/proxy.mjs`; it implements individually revocable credentials,
token-bucket rate limits, per-credential/global concurrency caps, and a
persistent owner-set daily paid-call budget. Deployment, restrictive upstream
key spend limits, and matching TLS-terminator controls remain the owner's job.

## Normalization and message boundary

The API normalizes submitted strings; the recipe does not claim identity with
original or outbound content. Conservative preflight rejects known
markup/entity/CSS/transfer-decoding triggers, but that does not prove coverage
of an arbitrary trigger message. Unmapped alternatives remain unanalyzed.
Accordingly, no recipe includes a sender or blocking route.

## Evidence and package

`npm test` uses Node built-ins and makes no network call or send. It compares the
bundled schema against the exact transitive OpenAPI schemas, imports the real
`visibleEmailText` implementation for regression evidence, runs the exact
Zapier Code sources in a VM, checks false consent defaults and fixed cURL
transport controls, and verifies deterministic archive contents.

`npm run pack` creates
`dist/sendrepute-automation-recipes-0.2.0.zip` from an explicit sorted allowlist
with fixed timestamps. Tests, fixtures, credentials, caches, dependencies, and
unrelated integrations are excluded.
## Paid-intent ledger (anti-duplicate)

Every paid or billing console call is recorded in a durable intent ledger **before** the request is sent. The identity is the credential fingerprint, operation, method, path and canonical body. An identical request is refused (409 `INTENT_LOCKED` / `INTENT_COMPLETED`) from any session, worker or restart while the intent is pending, ambiguous (timeout, transport error, 5xx, 408/425, malformed response) or completed. Definitive 4xx refusals unlock it. The upstream replay identity (`recoveryId`, or `analysisId`) is generated once, persisted with the intent and reused on resend, so the server can deduplicate. Operators review intents with the **Paid intents** button and release one only with a reason and an explicit confirmation. Releasing a completed intent issues a fresh replay id for a deliberate second charge. Pending intents are never released online or by timeout; after a worker crash, stop every worker and run offline recovery, which turns them into ambiguous intents for reconciliation. With no ledger configured, paid and billing operations return 503 `INTENT_STORE_REQUIRED`. The filesystem store supports a **single host only**, and it refuses to start unless you acknowledge that and its directory is absolute, `0700` and owned by the server user. Prices are always sent upstream for server-side enforcement, and a charge above consent is flagged. Classification (`classifyCustomerEmail`, POST /v1/classify) sends `priceAuthorization` with the four effective rates returned by this session's latest GET /v1/pricing plus the operator's ceiling. A confirmation that no longer matches the latest rates is refused (409 `PRICE_CONFIRMATION_STALE`) before anything is sent. The server re-checks rates and ceiling atomically at settlement (409 `PRICE_CHANGED`). Manual edit reclassification (`customerClassifyEmail`, POST /v1/classify/edit) has no price field in its request schema (`CustomerManualEditInput`, additionalProperties false); the server prices it authoritatively.

```js
import { FileIntentStore, startCustomerApiConsole } from "./src/customer-api/index.mjs";
await startCustomerApiConsole({ intentStore: new FileIntentStore({ directory: "/var/lib/sendrepute/intents", singleHost: true }) });
// or env: SENDREPUTE_CONSOLE_INTENT_DIR=/var/lib/sendrepute/intents SENDREPUTE_CONSOLE_INTENT_SINGLE_HOST=1
```

The Node lock is an exclusive-create lock file with **no time-based takeover**. A stalled owner keeps the lock, and other workers fail closed with 503 `INTENT_STORE_BUSY` without sending. A lock abandoned by a crashed worker stays in place until offline recovery, which you run only with every console worker stopped:

```sh
node -e 'import("./src/customer-api/index.mjs").then(m => console.log(m.recoverAbandonedIntentLocks({ directory: process.argv[1], allWorkersStopped: true })))' /var/lib/sendrepute/intents
```

### Browser fixture (no network, disposable credentials)

`node examples/console-fixture.mjs` serves the console on http://127.0.0.1:8787/sendrepute-admin with an in-process fake transport and a random fake API key. It prints a random operator token (or uses `FIXTURE_OPERATOR_TOKEN` if 24+ characters) and keeps a throwaway intent ledger. `globalThis.fetch` is disabled. Multi-host deployments must pass their own `IntentLedger` subclass backed by shared storage with atomic locks.
