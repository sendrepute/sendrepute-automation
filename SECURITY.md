# Security

SendRepute classification is paid. Leave both consent gates false until the
owner explicitly reviews charges. No included test contacts the API.

The bearer token is server configuration only. Make must store it in the HTTP
app secure keychain. Zapier Webhooks has no private SendRepute connection, so
the Zapier recipe must call an authenticated owner-controlled HTTPS proxy that
stores the token, redacts content, calls only the fixed SendRepute URL, follows
no redirect, retries zero times, uses bounded deadlines, and caps the response
at 1 MiB. Zap editors/history may expose ordinary Webhooks configuration; never
place the SendRepute token there.

Configure individual revocable proxy credentials, per-credential token-bucket
rate and concurrency limits, a global concurrency cap, a persistent daily call
budget, and a restrictive upstream SendRepute-key spend limit. Run one process
per budget file. The included server returns 429 before upstream when a limit is
reached and reserves budget durably before attempting a paid call. Its loopback
HTTPS terminator must mirror the 1 MiB body cap, short header/request/idle
timeouts, maximum connections, and client rate limits.

These are manual draft-analysis recipes, not send adapters. They analyze only
the exact mapped strings. An original message may contain unmapped HTML, MIME
alternatives, attachments, encoded/path-backed content, or different eventual
sender content. Do not use the result to approve, block, modify, or send that
message. Critical account/security mail receives no automated routing.

The API's real normalizer may decode base64/quoted-printable, remove markup,
entities, CSS terms, and repeated whitespace. Preflight rejection is
conservative evidence, not an identity guarantee. Display submitted fields and
the API result as advisory analysis only.

HTTP/validation failure stops each recipe. There is no claimed preserve or
Resume path and no fabricated substitute result. Disable Zapier Autoreplay and
do not add Make retry/repeater handlers. `billing.replayed` is a receipt fact,
not permission to retry.

Report vulnerabilities privately to the security contact supplied with the
SendRepute account. Do not include credentials or customer content.