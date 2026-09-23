const status = Number(inputData.status);
let value;
try {
  value = typeof inputData.response === "string"
    ? JSON.parse(inputData.response) : inputData.response;
} catch {
  throw new Error("SendRepute response is not JSON; stop");
}
const object = (v) => v && typeof v === "object" && !Array.isArray(v);
const finite = (v) => typeof v === "number" && Number.isFinite(v);
const integer = (v) => finite(v) && Number.isInteger(v);
const exact = (v, allowed, required) => object(v) &&
  Object.keys(v).every((key) => allowed.includes(key)) &&
  required.every((key) => Object.hasOwn(v, key));
const strings = (v) => Array.isArray(v) && v.every((item) => typeof item === "string");
const models = ["thor", "theos", "athena", "odin", "freya", "hermes", "ares", "apollo"];
const resultKeys = ["label", "spamProbability", "flaggedTermCount", "confidence",
  "reasons", "flaggedTerms", "analyzedFields", "modelVersion", "analyzedAt", "contentAudit"];
const resultRequired = ["label", "spamProbability", "confidence", "reasons",
  "flaggedTerms", "analyzedFields", "modelVersion", "analyzedAt"];
const reason = (v) => exact(v, ["signal", "detail", "weight"], ["signal", "detail", "weight"]) &&
  typeof v.signal === "string" && typeof v.detail === "string" && finite(v.weight);
const category = (v) => ["subject", "content", "links", "structure", "compliance"].includes(v);
const nonnegativeInteger = (v) => integer(v) && v >= 0;
const auditCounts = (v) => exact(v, ["words", "links", "images", "triggerPhrases"],
  ["words", "links", "images", "triggerPhrases"]) &&
  ["words", "links", "images", "triggerPhrases"].every((key) => nonnegativeInteger(v[key]));
const auditIssue = (v) => exact(v, ["code", "category", "severity", "deduction", "evidence"],
  ["code", "category", "severity", "deduction", "evidence"]) &&
  typeof v.code === "string" && category(v.category) &&
  ["critical", "warning", "suggestion"].includes(v.severity) &&
  integer(v.deduction) && v.deduction >= 0 && v.deduction <= 100 &&
  typeof v.evidence === "string" && v.evidence.length <= 200;
const goodPractice = (v) => exact(v, ["code", "category"], ["code", "category"]) &&
  typeof v.code === "string" && category(v.category);
const contentAudit = (v) => {
  const allowed = ["score", "grade", "summary", "counts", "totalIssues",
    "criticalCount", "warningCount", "suggestionCount", "issues", "goodPractices",
    "homoglyphTerms", "inputTruncated"];
  const required = ["score", "grade", "summary", "counts", "totalIssues",
    "criticalCount", "warningCount", "suggestionCount", "issues", "goodPractices",
    "inputTruncated"];
  return exact(v, allowed, required) && integer(v.score) && v.score >= 0 && v.score <= 100 &&
    ["A", "B", "C", "D", "F"].includes(v.grade) &&
    ["fix_critical", "fix_warnings", "review_suggestions", "looks_good"].includes(v.summary) &&
    auditCounts(v.counts) &&
    ["totalIssues", "criticalCount", "warningCount", "suggestionCount"]
      .every((key) => nonnegativeInteger(v[key])) &&
    Array.isArray(v.issues) && v.issues.length <= 50 && v.issues.every(auditIssue) &&
    Array.isArray(v.goodPractices) && v.goodPractices.length <= 20 &&
    v.goodPractices.every(goodPractice) &&
    (v.homoglyphTerms === undefined || (strings(v.homoglyphTerms) &&
      v.homoglyphTerms.length <= 20 && v.homoglyphTerms.every((item) => item.length <= 120))) &&
    typeof v.inputTruncated === "boolean";
};
const result = value && value.result;
const billing = value && value.billing;
const valid = status === 200 &&
  exact(value, ["requestId", "model", "result", "billing"],
    ["requestId", "model", "result", "billing"]) &&
  typeof value.requestId === "string" && value.requestId.length >= 1 &&
  value.requestId.length <= 128 && models.includes(value.model) &&
  exact(result, resultKeys, resultRequired) &&
  ["inbox", "spam"].includes(result.label) && finite(result.spamProbability) &&
  (result.flaggedTermCount === undefined || nonnegativeInteger(result.flaggedTermCount)) &&
  ["low", "medium", "high"].includes(result.confidence) &&
  Array.isArray(result.reasons) && result.reasons.every(reason) &&
  strings(result.flaggedTerms) && strings(result.analyzedFields) &&
  typeof result.modelVersion === "string" && typeof result.analyzedAt === "string" &&
  (result.contentAudit === undefined || contentAudit(result.contentAudit)) &&
  exact(billing, ["chargedMillicents", "replayed"], ["chargedMillicents", "replayed"]) &&
  nonnegativeInteger(billing.chargedMillicents) && typeof billing.replayed === "boolean";
if (!valid) throw new Error("SendRepute response does not match the complete public contract; stop");
output = {
  requestId: value.requestId,
  model: value.model,
  label: result.label,
  spamProbability: result.spamProbability,
  confidence: result.confidence,
  reasons: result.reasons,
  flaggedTerms: result.flaggedTerms,
  analyzedFields: result.analyzedFields,
  modelVersion: result.modelVersion,
  analyzedAt: result.analyzedAt,
  chargedMillicents: billing.chargedMillicents,
  replayed: billing.replayed
};