// Deliberate compile-time paid gate. The owner must review and change both.
const ENABLED = false;
const PAID_CONSENT = false;
if (ENABLED !== true || PAID_CONSENT !== true) {
  throw new Error("Paid SendRepute classification is disabled");
}
const sender = inputData.sender;
const subject = inputData.subject;
const body = inputData.body;
if (typeof sender !== "string" || sender.length < 1 || sender.length > 320 ||
    typeof subject !== "string" || subject.length < 1 || subject.length > 998 ||
    typeof body !== "string" || body.length < 1 || body.length > 524288) {
  throw new Error("sender, subject, or body violates the classify contract");
}
const ambiguous = (text) => {
  const compact = text.trim().replace(/\s+/g, "");
  return /[<>&{}]|\u200B|\u200C|\u200D|\u2060|\uFEFF|=\r?\n|=[0-9a-f]{2}|\s{2,}|\b(?:mso(?:-[a-z0-9-]+)?|border-collapse|font-family|font-size|line-height|text-decoration|table-layout)\b/i.test(text) ||
    (text.trim().length >= 80 && !/\s{2,}/.test(text.trim()) &&
     /^[A-Za-z0-9+/=\r\n]+$/.test(text.trim()) && compact.length % 4 === 0);
};
if ([sender, subject, body].some(ambiguous)) {
  throw new Error("A submitted field is ambiguous to API normalization");
}
for (const name of ["alternatives", "html", "mime", "attachments", "path", "encoding"]) {
  if (inputData[name] !== undefined && inputData[name] !== "") {
    throw new Error(`Unsupported displayed-content source: ${name}`);
  }
}
output = { sender, subject, body };