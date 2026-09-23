> **Standalone source distribution:** this repository contains the integration runtime, documentation, and source packager. Upstream workspace/CMS/production-normalizer regression suites are deliberately not distributed here because they depend on private server code or isolated platform fixtures. Testing commands and historical verification evidence below describe upstream maintainer validation, not a self-contained test suite in this source-only checkout. No third-party registry publication is implied.

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