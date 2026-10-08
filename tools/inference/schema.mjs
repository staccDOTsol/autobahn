// Independently authored restrictive Anchor 0.30 IDL schema. See README for supported scope.
export const object = (properties, required = Object.keys(properties)) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
export const text = { type: "string", minLength: 1, maxLength: 8192 };
const name = {
  type: "string",
  pattern: "^[A-Za-z_][A-Za-z0-9_]*$",
  maxLength: 128,
};
const docs = { type: "array", maxItems: 100, items: text };
const pubkey = { type: "string", pattern: "^[1-9A-HJ-NP-Za-km-z]{32,44}$" };
const byte = { type: "integer", minimum: 0, maximum: 255 };
const discriminator = { type: "array", minItems: 1, maxItems: 32, items: byte };
const list = (items, maxItems = 1024) => ({ type: "array", items, maxItems });
const ref = (key) => ({ $ref: `#/$defs/${key}` });
export const idlSchema = {
  $id: "https://aggregator.ag/schemas/inference/anchor-idl-subset-v1",
  ...object(
    {
      address: pubkey,
      metadata: object(
        {
          name,
          version: text,
          spec: { const: "0.1.0" },
          description: text,
          repository: text,
        },
        ["name", "version", "spec"],
      ),
      docs,
      instructions: { ...list(ref("instruction")), minItems: 1 },
      accounts: list(ref("accountDefinition")),
      events: list(ref("accountDefinition")),
      errors: list(
        object(
          {
            name,
            code: { type: "integer", minimum: 0, maximum: 4294967295 },
            msg: text,
          },
          ["name", "code"],
        ),
      ),
      types: list(ref("definition")),
      constants: list(object({ name, type: ref("type"), value: text })),
    },
    ["address", "metadata", "instructions"],
  ),
  $defs: {
    type: {
      anyOf: [
        {
          enum: [
            "bool",
            "u8",
            "i8",
            "u16",
            "i16",
            "u32",
            "i32",
            "f32",
            "u64",
            "i64",
            "f64",
            "u128",
            "i128",
            "u256",
            "i256",
            "bytes",
            "string",
            "pubkey",
          ],
        },
        ...["option", "coption", "vec"].map((key) =>
          object({ [key]: ref("type") }),
        ),
        object({
          array: {
            type: "array",
            items: [
              ref("type"),
              { type: "integer", minimum: 1, maximum: 1048576 },
            ],
            minItems: 2,
            maxItems: 2,
            additionalItems: false,
          },
        }),
        object({ defined: object({ name }) }),
      ],
    },
    field: object({ name, docs, type: ref("type") }, ["name", "type"]),
    fields: { anyOf: [list(ref("field")), list(ref("type"))] },
    seed: {
      anyOf: [
        object({
          kind: { const: "const" },
          value: { ...list(byte, 32), minItems: 1 },
        }),
        object({ kind: { const: "arg" }, path: text }),
        object({ kind: { const: "account" }, path: text, account: name }, [
          "kind",
          "path",
        ]),
      ],
    },
    account: {
      anyOf: [
        object(
          {
            name,
            docs,
            writable: { type: "boolean" },
            signer: { type: "boolean" },
            optional: { type: "boolean" },
            address: pubkey,
            pda: object(
              { seeds: list(ref("seed"), 16), program: ref("seed") },
              ["seeds"],
            ),
            relations: list(name, 128),
          },
          ["name"],
        ),
        object({ name, accounts: list(ref("account"), 128) }),
      ],
    },
    instruction: object(
      {
        name,
        docs,
        discriminator,
        accounts: list(ref("account"), 256),
        args: list(ref("field"), 128),
        returns: ref("type"),
      },
      ["name", "discriminator", "accounts", "args"],
    ),
    accountDefinition: object({ name, discriminator }),
    definition: object(
      {
        name,
        docs,
        serialization: { const: "borsh" },
        type: {
          anyOf: [
            object({ kind: { const: "struct" }, fields: ref("fields") }, [
              "kind",
            ]),
            object({
              kind: { const: "enum" },
              variants: {
                ...list(object({ name, fields: ref("fields") }, ["name"]), 256),
                minItems: 1,
              },
            }),
            object({ kind: { const: "type" }, alias: ref("type") }),
          ],
        },
      },
      ["name", "type"],
    ),
  },
};
export const candidateSchema = object({
  schemaVersion: { const: 1 },
  programId: pubkey,
  idl: { $ref: idlSchema.$id },
  claims: {
    ...list(
      object({
        instruction: name,
        evidence: {
          ...list({ type: "string", pattern: "^[a-f0-9]{64}$" }, 100),
          minItems: 1,
        },
        rationale: text,
      }),
    ),
    minItems: 1,
  },
  uncertainties: list(text, 100),
});
