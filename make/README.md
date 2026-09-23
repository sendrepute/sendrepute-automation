# Make paid draft-analysis recipe

This recipe analyzes three selected strings and displays the paid result. It
does not send, approve, block, or preserve an email and does not claim coverage
of unmapped MIME/HTML/attachments. It is a manual current-module recipe, not a
blueprint or a SendRepute-approved Make app.

## Exact scenario

1. Add the customer's draft/content trigger. Select only sender display name,
   subject, and one body string for analysis.
2. Add **Tools → Set multiple variables** with:
   - `enabled` = boolean `false`
   - `paidConsent` = boolean `false`
   These are persisted literals in the scenario. The owner must deliberately
   change both to boolean `true` after reviewing paid use.
3. Add a filter named **Paid classification explicitly enabled** between Tools
   and JSON. Conditions, joined with AND:
   - `enabled` / Equal to / boolean `true`
   - `paidConsent` / Equal to / boolean `true`
   Missing or false values terminate the bundle before HTTP.
4. Add **JSON → Create JSON**. Create a data structure containing exactly three
   required text fields: `sender`, `subject`, `body`. Map the selected trigger
   strings. This module performs JSON escaping; do not hand-build JSON.
5. Add the current **HTTP → Make a request** module:
   - URL: `https://www.sendrepute.com/api/v1/classify`
   - Method: `POST`
   - Authentication: API key credential in the HTTP app secure keychain
   - API key placement: header; key `Authorization`; value
     `Bearer <SendRepute token>` (entered only in the credential dialog)
   - Body type / request content: `Raw`
   - Content type: `application/json` (select the application/json control; do
     not add a conflicting free-text Content-Type header)
   - Request content/body: map the serialized JSON output from step 4
   - Parse response: Yes; Follow redirect: No; Timeout: 10 seconds
   - Maximum response size: 1 MiB where the current module exposes that control
   If the account's HTTP module cannot enforce 1 MiB, do not run this direct
   recipe; use an owner-controlled bounded proxy. Do not add a repeater or
   automatic retry error handler.
6. Add a filter named **Minimal display guard** requiring status
   code numeric `200`, non-empty `requestId`, non-empty `model`, `result.label`
   equal to `inbox` OR `spam`, numeric `result.spamProbability`,
   `billing.chargedMillicents` Exists, and `billing.replayed` Exists. Use Exists
   for billing so valid zero/false values pass. This filter is
   only a display guard, not full schema validation. The complete generated
   contract is `examples/classify-response.schema.json`.
7. Add a private review/record module to display the result and billing receipt.
   Do not add a sender or allow/block router. On HTTP errors use Make's **Break**
   error handler (no Resume substitute), so no result is fabricated and no
   later action runs.

Keep scenario scheduling OFF while testing with a mock HTTP endpoint. Exported
scenario JSON must not contain credentials; Make stores the API key credential
separately. The package tests make no paid calls and do not claim live editor
certification.