import { z } from "zod";

/**
 * Zod → strict JSON Schema для `output_config.format`.
 *
 * Хелпер SDK (`zodOutputFormat`) переносить `enum`/`const` в опис, тож API їх не форсує.
 * Тут вони лишаються в схемі; непідтримувані обмеження (min/max, довжини, pattern)
 * переносяться в `description` як підказка моделі й перевіряються Zod після відповіді.
 */

const SUPPORTED_FORMATS = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "uri",
  "ipv4",
  "ipv6",
  "uuid",
]);

type Json = Record<string, unknown>;

export class UnsupportedSchemaError extends Error {
  override name = "UnsupportedSchemaError";
}

const SAFE_INT_BOUNDS = new Set([Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER]);

function strictNode(input: Json): Json {
  const node: Json = { ...input };
  const out: Json = {};
  delete node.$schema;

  for (const key of ["$ref", "$defs"] as const) {
    if (node[key] === undefined) continue;
    if (key === "$ref") out.$ref = node.$ref;
    else
      out.$defs = Object.fromEntries(
        Object.entries(node.$defs as Record<string, Json>).map(([k, v]) => [k, strictNode(v)]),
      );
    delete node[key];
  }

  const variants = (node.anyOf ?? node.oneOf) as Json[] | undefined;
  if (variants) out.anyOf = variants.map(strictNode);
  if (node.allOf) out.allOf = (node.allOf as Json[]).map(strictNode);
  delete node.anyOf;
  delete node.oneOf;
  delete node.allOf;

  if (
    node.type === undefined &&
    !variants &&
    !node.allOf &&
    !out.$ref &&
    node.enum === undefined &&
    node.const === undefined
  ) {
    throw new UnsupportedSchemaError(
      `вузол без типу (z.unknown/z.any?): ${JSON.stringify(input).slice(0, 120)}`,
    );
  }
  if (node.additionalProperties !== undefined && node.additionalProperties !== false) {
    throw new UnsupportedSchemaError("z.record / відкриті об'єкти не підтримуються structured output");
  }

  if (node.type !== undefined) out.type = node.type;
  const types = Array.isArray(node.type) ? node.type : [node.type];
  delete node.type;

  for (const key of ["enum", "const", "description", "title"] as const) {
    if (node[key] !== undefined) out[key] = node[key];
    delete node[key];
  }

  if (types.includes("object")) {
    const props = (node.properties ?? {}) as Record<string, Json>;
    out.properties = Object.fromEntries(Object.entries(props).map(([k, v]) => [k, strictNode(v)]));
    out.required = node.required ?? [];
    out.additionalProperties = false;
    delete node.properties;
    delete node.required;
    delete node.additionalProperties;
  }
  if (types.includes("array")) {
    if (node.items) out.items = strictNode(node.items as Json);
    delete node.items;
    if (node.minItems === 0 || node.minItems === 1) {
      out.minItems = node.minItems;
      delete node.minItems;
    }
  }
  if (types.includes("string") && typeof node.format === "string" && SUPPORTED_FORMATS.has(node.format)) {
    out.format = node.format;
    delete node.format;
  }
  for (const k of ["minimum", "maximum"]) {
    if (typeof node[k] === "number" && SAFE_INT_BOUNDS.has(node[k] as number)) delete node[k];
  }

  const rest = Object.entries(node);
  if (rest.length > 0) {
    const hint = rest.map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ");
    out.description = out.description ? `${out.description}\n{${hint}}` : `{${hint}}`;
  }
  return out;
}

export function toStrictJsonSchema(schema: z.ZodType): Json {
  const raw = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "output",
    reused: "inline",
    unrepresentable: "throw",
  });
  return strictNode(raw as Json);
}
