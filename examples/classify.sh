#!/bin/sh
set -eu

: "${SENDREPUTE_API_TOKEN:?Set SENDREPUTE_API_TOKEN in server-side secret configuration}"
request_file="${1:-examples/classify-request.json}"

curl --silent --show-error --fail-with-body \
  --proto '=https' --tlsv1.2 \
  --connect-timeout 3 --max-time 10 --max-redirs 0 --max-filesize 1048576 \
  --request POST 'https://www.sendrepute.com/api/v1/classify' \
  --header "Authorization: Bearer ${SENDREPUTE_API_TOKEN}" \
  --header 'Content-Type: application/json' \
  --data-binary "@${request_file}"