/**
 * TypeScript types from an OpenAPI 3.x document, in the shape openapi-fetch
 * reads: `paths`, `components` and `operations`. It covers the JSON Schema
 * that Zod and @hono/zod-openapi emit (objects, arrays, tuples, enums,
 * consts, unions, intersections, nullable types, refs and records) and needs
 * no TypeScript compiler, so it runs wherever Node does.
 */

type Json = Record<string, unknown>;

const METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
] as const;
const PARAM_PLACES = ["query", "header", "path", "cookie"] as const;
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const key = (name: string) => (IDENT.test(name) ? name : JSON.stringify(name));

const literal = (v: unknown) =>
  v === null ? "null" : typeof v === "object" ? "unknown" : JSON.stringify(v);

function doc(text: unknown, pad: string): string {
  if (typeof text !== "string" || text.trim() === "") return "";
  const lines = text.trim().replace(/\*\//g, "*\\/").split("\n");
  if (lines.length === 1) return `${pad}/** ${lines[0]} */\n`;
  return `${pad}/**\n${lines.map((l) => `${pad} * ${l}`.trimEnd()).join("\n")}\n${pad} */\n`;
}

function refType(ref: string): string {
  const parts = ref
    .replace(/^#\//, "")
    .split("/")
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  const [head, ...rest] = parts;
  return `${head}${rest.map((p) => `[${JSON.stringify(p)}]`).join("")}`;
}

const union = (types: string[]) => {
  const unique = [...new Set(types)];
  if (unique.includes("unknown")) return "unknown";
  return unique.length === 0 ? "never" : unique.join(" | ");
};

/** Whether `t` has a `|` or `&` outside every bracket and string, so it needs parentheses to sit inside another type. */
function topLevelOperator(t: string): boolean {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "{" || c === "(" || c === "[" || c === "<") depth++;
    else if (c === "}" || c === ")" || c === "]" || c === ">") depth--;
    else if ((c === "|" || c === "&") && depth === 0) return true;
  }
  return false;
}

const wrap = (t: string) => (topLevelOperator(t) ? `(${t})` : t);

/** The TypeScript type for one schema. `pad` is the current indentation. */
export function schemaType(schema: unknown, pad = ""): string {
  if (schema === true || schema === undefined) return "unknown";
  if (schema === false) return "never";
  if (!isObject(schema)) return "unknown";
  if (typeof schema.$ref === "string") {
    return withNull(refType(schema.$ref), schema);
  }
  if ("const" in schema) return withNull(literal(schema.const), schema);
  if (Array.isArray(schema.enum)) {
    return withNull(union(schema.enum.map(literal)), schema);
  }
  for (const k of ["anyOf", "oneOf"] as const) {
    const list = schema[k];
    if (Array.isArray(list)) {
      const rest = { ...schema, [k]: undefined };
      const base = hasType(rest) ? [schemaType(rest, pad)] : [];
      const options = union(list.map((s) => schemaType(s, pad)));
      return withNull(
        base.length ? `${wrap(base[0] as string)} & ${wrap(options)}` : options,
        schema,
      );
    }
  }
  if (Array.isArray(schema.allOf)) {
    const parts = schema.allOf.map((s) => wrap(schemaType(s, pad)));
    return withNull(parts.length ? parts.join(" & ") : "unknown", schema);
  }
  const types = Array.isArray(schema.type)
    ? (schema.type as unknown[])
    : schema.type === undefined
      ? inferType(schema)
      : [schema.type];
  if (types.length === 0) return "unknown";
  return withNull(
    union(types.map((t) => typeFor(String(t), schema, pad))),
    schema,
  );
}

function hasType(schema: Json): boolean {
  return (
    schema.type !== undefined ||
    schema.properties !== undefined ||
    schema.items !== undefined
  );
}

function inferType(schema: Json): unknown[] {
  if (schema.properties || schema.additionalProperties !== undefined)
    return ["object"];
  if (schema.items || schema.prefixItems) return ["array"];
  return [];
}

function withNull(type: string, schema: Json): string {
  return schema.nullable === true ? union([type, "null"]) : type;
}

function typeFor(type: string, schema: Json, pad: string): string {
  switch (type) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array":
      return arrayType(schema, pad);
    case "object":
      return objectType(schema, pad);
    default:
      return "unknown";
  }
}

function arrayType(schema: Json, pad: string): string {
  if (Array.isArray(schema.prefixItems)) {
    const items = schema.prefixItems.map((s) => schemaType(s, pad));
    const rest =
      schema.items === false || schema.items === undefined
        ? []
        : [`...${wrap(schemaType(schema.items, pad))}[]`];
    return `[${[...items, ...rest].join(", ")}]`;
  }
  return `${wrap(schemaType(schema.items, pad))}[]`;
}

function objectType(schema: Json, pad: string): string {
  const props = isObject(schema.properties) ? schema.properties : {};
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.map(String) : [],
  );
  const inner = `${pad}  `;
  let body = "";
  for (const [name, prop] of Object.entries(props)) {
    const optional = required.has(name) ? "" : "?";
    body += doc(isObject(prop) ? prop.description : undefined, inner);
    body += `${inner}${key(name)}${optional}: ${schemaType(prop, inner)};\n`;
  }
  const extra = schema.additionalProperties;
  if (extra !== undefined && extra !== false) {
    body += `${inner}[key: string]: ${extra === true ? "unknown" : schemaType(extra, inner)};\n`;
  } else if (
    extra === undefined &&
    Object.keys(props).length === 0 &&
    schema.propertyNames === undefined
  ) {
    body += `${inner}[key: string]: unknown;\n`;
  }
  if (body === "") return "Record<string, never>";
  return `{\n${body}${pad}}`;
}

function resolve(value: unknown, document: Json): Json {
  let current = value;
  for (
    let i = 0;
    i < 10 && isObject(current) && typeof current.$ref === "string";
    i++
  ) {
    let target: unknown = document;
    for (const part of current.$ref.replace(/^#\//, "").split("/")) {
      target = isObject(target)
        ? target[part.replace(/~1/g, "/").replace(/~0/g, "~")]
        : undefined;
    }
    current = target;
  }
  return isObject(current) ? current : {};
}

function parametersType(
  params: unknown[],
  document: Json,
  pad: string,
): string {
  const inner = `${pad}  `;
  const byPlace = new Map<string, Json[]>();
  for (const p of params) {
    const param = resolve(p, document);
    const place = String(param.in);
    byPlace.set(place, [...(byPlace.get(place) ?? []), param]);
  }
  let body = "";
  for (const place of PARAM_PLACES) {
    const list = byPlace.get(place);
    if (!list || list.length === 0) {
      body += `${inner}${place}?: never;\n`;
      continue;
    }
    const anyRequired = list.some(
      (p) => p.required === true || place === "path",
    );
    let fields = "";
    for (const p of list) {
      const optional = p.required === true || place === "path" ? "" : "?";
      fields += doc(p.description, `${inner}  `);
      fields += `${inner}  ${key(String(p.name))}${optional}: ${schemaType(p.schema, `${inner}  `)};\n`;
    }
    body += `${inner}${place}${anyRequired ? "" : "?"}: {\n${fields}${inner}};\n`;
  }
  return `{\n${body}${pad}}`;
}

function contentType(content: unknown, pad: string): string {
  if (!isObject(content) || Object.keys(content).length === 0) return "";
  const inner = `${pad}  `;
  let body = "";
  for (const [media, value] of Object.entries(content)) {
    const schema = isObject(value) ? value.schema : undefined;
    body += `${inner}${JSON.stringify(media)}: ${schemaType(schema, inner)};\n`;
  }
  return `{\n${body}${pad}}`;
}

function operationType(
  op: Json,
  pathParams: unknown[],
  document: Json,
  pad: string,
): string {
  const inner = `${pad}  `;
  const own = Array.isArray(op.parameters) ? op.parameters : [];
  const merged = new Map<string, unknown>();
  for (const p of [...pathParams, ...own]) {
    const r = resolve(p, document);
    merged.set(`${r.in}:${r.name}`, p);
  }
  let body = `${inner}parameters: ${parametersType([...merged.values()], document, inner)};\n`;
  if (op.requestBody === undefined) {
    body += `${inner}requestBody?: never;\n`;
  } else {
    const rb = resolve(op.requestBody, document);
    const content = contentType(rb.content, `${inner}  `);
    const optional = rb.required === true ? "" : "?";
    body += `${inner}requestBody${optional}: {\n${inner}  content: ${content || "Record<string, never>"};\n${inner}};\n`;
  }
  const responses = isObject(op.responses) ? op.responses : {};
  let rbody = "";
  for (const [status, value] of Object.entries(responses)) {
    const res = resolve(value, document);
    const content = contentType(res.content, `${inner}    `);
    rbody += doc(res.description, `${inner}  `);
    rbody += `${inner}  ${/^\d+$/.test(status) ? status : JSON.stringify(status)}: {\n`;
    rbody += `${inner}    headers: {\n${inner}      [name: string]: unknown;\n${inner}    };\n`;
    rbody += content
      ? `${inner}    content: ${content};\n`
      : `${inner}    content?: never;\n`;
    rbody += `${inner}  };\n`;
  }
  body += `${inner}responses: {\n${rbody}${inner}};\n`;
  return `{\n${body}${pad}}`;
}

/** The whole types module for an OpenAPI document. */
export function openApiTypes(document: object): string {
  const docJson = document as Json;
  const paths = isObject(docJson.paths) ? docJson.paths : {};
  const operations: string[] = [];
  let pathsBody = "";
  for (const [path, value] of Object.entries(paths)) {
    if (!isObject(value)) continue;
    const item = resolve(value, docJson);
    const shared = Array.isArray(item.parameters) ? item.parameters : [];
    pathsBody += `  ${JSON.stringify(path)}: {\n`;
    pathsBody += `    parameters: ${parametersType(shared, docJson, "    ")};\n`;
    for (const method of METHODS) {
      const op = item[method];
      if (!isObject(op)) {
        pathsBody += `    ${method}?: never;\n`;
        continue;
      }
      if (typeof op.operationId === "string") {
        operations.push(
          `${doc(op.summary, "  ")}  ${key(op.operationId)}: ${operationType(op, shared, docJson, "  ")};\n`,
        );
        pathsBody += `${doc(op.summary, "    ")}    ${method}: operations[${JSON.stringify(op.operationId)}];\n`;
      } else {
        pathsBody += `${doc(op.summary, "    ")}    ${method}: ${operationType(op, shared, docJson, "    ")};\n`;
      }
    }
    pathsBody += "  };\n";
  }

  const components = isObject(docJson.components) ? docJson.components : {};
  let componentsBody = "";
  for (const section of [
    "schemas",
    "responses",
    "parameters",
    "requestBodies",
    "headers",
    "pathItems",
  ]) {
    const entries = isObject(components[section])
      ? Object.entries(components[section] as Json)
      : [];
    if (entries.length === 0 || section !== "schemas") {
      componentsBody += `  ${section}: never;\n`;
      continue;
    }
    let body = "";
    for (const [name, schema] of entries) {
      body += doc(isObject(schema) ? schema.description : undefined, "    ");
      body += `    ${key(name)}: ${schemaType(schema, "    ")};\n`;
    }
    componentsBody += `  schemas: {\n${body}  };\n`;
  }

  return [
    `export interface paths {\n${pathsBody}}`,
    "export type webhooks = Record<string, never>;",
    `export interface components {\n${componentsBody}}`,
    "export type $defs = Record<string, never>;",
    operations.length
      ? `export interface operations {\n${operations.join("")}}`
      : "export type operations = Record<string, never>;",
    "",
  ].join("\n");
}
