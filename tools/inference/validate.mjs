import Ajv from "ajv";
import { createHash } from "node:crypto";
import { candidateSchema, idlSchema } from "./schema.mjs";

const ajv = new Ajv({ strict: true, allErrors: false });
const checkIdl = ajv.compile(idlSchema);
const checkCandidate = ajv.compile(candidateSchema);
export const sha256 = (value) =>
  createHash("sha256").update(value).digest("hex");
export const canonical = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );
export function insist(condition, message) {
  if (!condition) throw new Error(message);
}
export function boundedJson(text, limit = 2 * 1024 * 1024) {
  insist(
    typeof text === "string" && Buffer.byteLength(text) <= limit,
    "JSON input exceeds its size limit",
  );
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Invalid JSON input");
  }
  const pending = [[value, 0]];
  let nodes = 0;
  while (pending.length) {
    const [item, depth] = pending.pop();
    insist(
      depth <= 48 && ++nodes <= 100000,
      "JSON structure exceeds complexity limit",
    );
    if (item && typeof item === "object")
      for (const [key, child] of Object.entries(item)) {
        insist(
          !["__proto__", "constructor", "prototype"].includes(key),
          "Forbidden object key",
        );
        pending.push([child, depth + 1]);
      }
  }
  return value;
}
export function publicKey(value) {
  insist(
    typeof value === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value),
    "Invalid Solana public key",
  );
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let number = 0n;
  for (const char of value)
    number = number * 58n + BigInt(alphabet.indexOf(char));
  let bytes = 0;
  while (number) {
    bytes++;
    number >>= 8n;
  }
  insist(
    bytes + (value.match(/^1*/)?.[0].length ?? 0) === 32,
    "Solana public key must decode to 32 bytes",
  );
  return value;
}
function unique(rows, key, label) {
  const values = rows.map((row) => row[key]);
  insist(new Set(values).size === values.length, `Duplicate ${label}`);
}
export function validateIdl(idl, expectedProgram) {
  insist(
    checkIdl(idl),
    `Unsupported or invalid IDL schema: ${ajv.errorsText(checkIdl.errors)}`,
  );
  insist(
    publicKey(idl.address) === expectedProgram,
    "IDL address does not match its evidence program",
  );
  const types = new Set((idl.types ?? []).map((row) => row.name));
  for (const key of [
    "instructions",
    "types",
    "accounts",
    "events",
    "errors",
    "constants",
  ])
    unique(idl[key] ?? [], "name", `${key} name`);
  unique(idl.errors ?? [], "code", "error code");
  const discriminators = idl.instructions.map((ix) =>
    Buffer.from(ix.discriminator).toString("hex"),
  );
  for (let a = 0; a < discriminators.length; a++)
    for (let b = a + 1; b < discriminators.length; b++)
      insist(
        !discriminators[a].startsWith(discriminators[b]) &&
          !discriminators[b].startsWith(discriminators[a]),
        "Ambiguous instruction discriminators",
      );
  for (const row of [...(idl.accounts ?? []), ...(idl.events ?? [])])
    insist(
      types.has(row.name),
      "Account/event definition has no matching type",
    );
  const walk = (item) => {
    if (!item || typeof item !== "object") return;
    if (item.defined)
      insist(types.has(item.defined.name), "Unresolved defined IDL type");
    if (item.address) publicKey(item.address);
    if (Array.isArray(item.fields) && item.fields[0]?.name)
      unique(item.fields, "name", "field name");
    if (item.variants) unique(item.variants, "name", "enum variant");
    if (Array.isArray(item.accounts))
      unique(item.accounts, "name", "instruction account name");
    if (item.args) unique(item.args, "name", "instruction argument");
    for (const child of Object.values(item))
      if (child && typeof child === "object")
        Array.isArray(child) ? child.forEach(walk) : walk(child);
  };
  walk(idl);
  return idl;
}
export function validateCandidate(candidate, evidence) {
  insist(
    checkCandidate(candidate),
    `Invalid proposal schema: ${ajv.errorsText(checkCandidate.errors)}`,
  );
  insist(
    candidate.programId === evidence.programId,
    "Proposal targets another program",
  );
  validateIdl(candidate.idl, evidence.programId);
  const instructions = new Set(candidate.idl.instructions.map((ix) => ix.name));
  const hashes = new Set(evidence.files.map((file) => file.sha256));
  unique(candidate.claims, "instruction", "instruction claim");
  for (const claim of candidate.claims) {
    insist(
      instructions.has(claim.instruction),
      "Claim references an unknown instruction",
    );
    insist(
      claim.evidence.every((hash) => hashes.has(hash)),
      "Claim references evidence that was not supplied",
    );
  }
  insist(
    candidate.claims.length === instructions.size,
    "Every instruction requires an evidence claim",
  );
  return candidate;
}
