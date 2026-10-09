// Operator console for the full SendRepute customer API.
// Required: SENDREPUTE_API_KEY, SENDREPUTE_CONSOLE_OPERATOR_TOKEN (24+ chars).
// Paid and billing operations need SENDREPUTE_CONSOLE_INTENT_DIR (absolute, chmod 700)
// plus SENDREPUTE_CONSOLE_INTENT_SINGLE_HOST=1; without them they are refused.
// Binds to 127.0.0.1:8787 unless SENDREPUTE_CONSOLE_TLS_TERMINATED=1 behind HTTPS.
import { startCustomerApiConsole } from "../src/customer-api/index.mjs";

const server = await startCustomerApiConsole({ product: "SendRepute automation recipes" });
const address = server.address();
console.log(`SendRepute console listening on http://${address.address}:${address.port}/sendrepute-admin`);
