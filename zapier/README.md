# Zapier paid draft-analysis recipe

This recipe analyzes three deliberately selected strings and displays the paid
API result. It is **not** a pre-send adapter, does not approve a whole MIME
message, and never invokes a sender. There is no SendRepute Zapier app,
marketplace approval, or import artifact claim.

Zapier Webhooks does not provide a private SendRepute authentication
connection. Do not put the SendRepute bearer token in a Webhooks header: Zap
editors and task-history access may expose step configuration or output.
Instead, this recipe requires an owner-controlled HTTPS proxy that stores the
SendRepute token in server configuration and performs the fixed, bounded call.
`examples/proxy.mjs` is the runnable Node proxy source. It binds loopback for an
operator-supplied HTTPS reverse proxy and accepts only `POST /classify`. Required
server environment values are `SENDREPUTE_ENABLED=true`,
`SENDREPUTE_PAID_CONSENT=true`, `SENDREPUTE_API_TOKEN`,
`SENDREPUTE_PROXY_CREDENTIALS` (JSON object of individually revocable
credential IDs to secrets of at least 16 characters),
`SENDREPUTE_RATE_PER_MINUTE`, `SENDREPUTE_PER_CREDENTIAL_CONCURRENCY`,
`SENDREPUTE_GLOBAL_CONCURRENCY`, `SENDREPUTE_DAILY_CALL_BUDGET`, and an absolute
persistent `SENDREPUTE_BUDGET_FILE`. It logs no content, allows one attempt, uses the
fixed API host/path, rejects every non-200 (including redirects), enforces
3-second TLS-connect and 10-second response deadlines, and caps both directions
at 1 MiB. Limits return 429 before upstream; budget reservation is persisted
before the paid attempt. Run one proxy process per budget file. Also set a
restrictive spend limit on the underlying SendRepute key. The HTTPS reverse
proxy must enforce matching 1 MiB body, header/request/idle deadlines, connection
and rate limits. Start with `node examples/proxy.mjs`; this package does not
deploy it. Zapier's larger platform payload limit does not replace the proxy cap.

## Exact Zap

1. Add the customer's draft/content trigger. This recipe makes no claim about
   unmapped HTML, MIME alternatives, attachments, or eventual outbound content.
   Select only the three strings the owner wants the API to analyze.
2. Add **Code by Zapier → Run JavaScript**. Map `sender`, `subject`, and `body`
   only. Paste `zapier/preflight.js`. The file has compile-time
   `ENABLED=false` and `PAID_CONSENT=false`; the owner must review charges and
   deliberately change both literals to `true`. Until then it throws before
   HTTP. It validates lengths and rejects ambiguous normalization triggers.
3. Add **Webhooks by Zapier → POST** (not Custom Request):
   - URL: the owner-controlled proxy URL.
   - Payload Type: `json`.
   - Data rows: `sender` → preflight `sender`, `subject` → preflight `subject`,
     `body` → preflight `body`.
   - Wrap Request In Array: `No`; Unflatten: `No`.
   - Header `Authorization`: `Bearer <credential-id>.<credential-secret>`. This limited
     proxy credential is visible to authorized Zap editors/history; restrict,
     rotate, and revoke it accordingly. It is not the SendRepute token.
   Zapier's POST action serializes the mapped values as JSON, including quotes
   and newlines. Never manually interpolate a raw JSON string.
4. Add **Code by Zapier → Run JavaScript**. Map Webhooks `Status Code` to
   `status` and its parsed response to `response`; paste
   `zapier/validate-response.js`. Any non-200 or incomplete contract throws and
   stops the Zap.
5. Add a private review/record action that displays `requestId`, `model`,
   `label`, `spamProbability`, and billing fields. Do not add a mail sender,
   Paths-based allow/block route, or error-preserve route. A failed Webhook or
   Code step stops the Zap; no failure bundle is claimed.

Keep the Zap OFF while testing with a proxy mock fixture. Do not enable Zapier
Autoreplay. Tests in this package run the exact Code sources offline but do not
certify Zapier UI versions or make a paid request.