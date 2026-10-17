// A strict JSON reader. JSON.parse keeps the last of two equal keys, so
// {"protected": true, "protected": false} would silently lose the first.
// This reader refuses duplicate keys (and anything JSON.parse refuses), so
// a security-relevant field can never be ambiguous.
//
// It returns a tagged value tree: every consumer branches on the kind the
// reader actually parsed, and JsonReader decodes that tree into the
// owner's contract (a closed object, an array, a string, an enum value),
// failing closed with the owner's own error.

export class JsonError extends Error {}

export type JsonFields = ReadonlyMap<string, JsonValue>;

export type JsonValue =
  | { readonly kind: "null" }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "array"; readonly items: readonly JsonValue[] }
  | { readonly kind: "object"; readonly fields: JsonFields };

const LIT = /(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/y;
const STR = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;

const ESCAPES: ReadonlyMap<string, string> = new Map([
  ['"', '"'],
  ["\\", "\\"],
  ["/", "/"],
  ["b", "\b"],
  ["f", "\f"],
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
]);

// The text of a token that STR matched, quotes included, decoded as
// JSON.parse decodes it (a \u escape is one UTF-16 code unit, unpaired
// surrogates included).
function unescape(token: string): string {
  let out = "";
  let k = 1;

  while (k < token.length - 1) {
    const slash = token.indexOf("\\", k);

    if (slash < 0 || slash >= token.length - 1) {
      out += token.slice(k, token.length - 1);
      break;
    }

    out += token.slice(k, slash);
    const e = token[slash + 1];

    if (e === "u") {
      out += String.fromCharCode(Number.parseInt(token.slice(slash + 2, slash + 6), 16));
      k = slash + 6;
      continue;
    }

    const c = ESCAPES.get(e);

    if (c === undefined) throw new JsonError(`malformed escape \\${e}`);
    out += c;
    k = slash + 2;
  }

  return out;
}

export function parseStrict(text: string): JsonValue {
  let i = 0;

  const fail: (msg: string) => never = (msg) => {
    const line = text.slice(0, i).split("\n").length;
    throw new JsonError(`${msg} (line ${line})`);
  };

  const ws = () => {
    while (i < text.length && " \t\n\r".includes(text[i])) i++;
  };

  const str = (): string => {
    STR.lastIndex = i;
    const m = STR.exec(text);

    if (!m) return fail("malformed string");
    i += m[0].length;

    return unescape(m[0]);
  };

  const value = (depth: number): JsonValue => {
    if (depth > 32) fail("nesting too deep");
    ws();
    const c = text[i];

    if (c === "{") {
      i++;
      const fields = new Map<string, JsonValue>();
      ws();

      if (text[i] === "}") {
        i++;

        return { kind: "object", fields };
      }

      for (;;) {
        ws();

        if (text[i] !== '"') fail("expected a string key");
        const k = str();

        if (fields.has(k)) fail(`duplicate key "${k}"`);
        ws();

        if (text[i] !== ":") fail("expected ':'");
        i++;
        fields.set(k, value(depth + 1));
        ws();

        if (text[i] === ",") {
          i++;
          continue;
        }

        if (text[i] === "}") {
          i++;

          return { kind: "object", fields };
        }

        fail("expected ',' or '}'");
      }
    }

    if (c === "[") {
      i++;
      const items: JsonValue[] = [];
      ws();

      if (text[i] === "]") {
        i++;

        return { kind: "array", items };
      }

      for (;;) {
        items.push(value(depth + 1));
        ws();

        if (text[i] === ",") {
          i++;
          continue;
        }

        if (text[i] === "]") {
          i++;

          return { kind: "array", items };
        }

        fail("expected ',' or ']'");
      }
    }

    if (c === '"') return { kind: "string", value: str() };
    LIT.lastIndex = i;
    const m = LIT.exec(text);

    if (!m) return fail("unexpected token");
    i += m[0].length;

    switch (m[0]) {
      case "true":
        return { kind: "boolean", value: true };
      case "false":
        return { kind: "boolean", value: false };
      case "null":
        return { kind: "null" };
      default:
        // the token matched JSON's number grammar: Number reads it exactly
        // as JSON.parse does
        return { kind: "number", value: Number(m[0]) };
    }
  };

  const v = value(0);
  ws();

  if (i !== text.length) fail("trailing content");

  return v;
}

// The JSON text of a parsed value, compact, with every object's keys in
// document order, integer-like keys included. That is what JSON.stringify
// prints for the value JSON.parse returns, except that JS objects list
// integer-like keys ("1", "2") first. Used to compare a recorded document
// with a recomputed one byte for byte; the documents compared have no
// integer-like keys.
export function stringify(v: JsonValue): string {
  switch (v.kind) {
    case "null":
      return "null";
    case "boolean":
      return v.value ? "true" : "false";
    case "number":
      return JSON.stringify(v.value);
    case "string":
      return JSON.stringify(v.value);
    case "array":
      return `[${v.items.map(stringify).join(",")}]`;
    case "object":
      return `{${[...v.fields].map(([k, x]) => `${JSON.stringify(k)}:${stringify(x)}`).join(",")}}`;
  }
}

// The documents this project writes: what JSON.stringify prints faithfully.
export type JsonData =
  | null
  | boolean
  | number
  | string
  | readonly JsonData[]
  | { readonly [k: string]: JsonData | undefined };

export const sameJson = (a: JsonData, b: JsonData): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

// whether a recomputed document prints exactly as a recorded one
export const matchesRecorded = (a: JsonData, recorded: JsonValue | undefined): boolean =>
  recorded !== undefined && JSON.stringify(a) === stringify(recorded);

// Decoders from a parsed value into an owner's contract. `fail` throws the
// owner's error (input, ledger, provider, artifact) with a location.
export class JsonReader {
  constructor(readonly fail: (where: string, detail: string) => never) {}

  // a closed object: exactly the required keys, and only the optional ones besides
  object(
    v: JsonValue | undefined,
    where: string,
    required: readonly string[],
    optional: readonly string[] = [],
  ): JsonFields {
    const fields = this.fields(v, where);

    for (const k of fields.keys()) {
      if (!required.includes(k) && !optional.includes(k)) this.fail(where, `unknown field "${k}"`);
    }

    for (const k of required) {
      if (!fields.has(k)) this.fail(where, `missing required field "${k}"`);
    }

    return fields;
  }

  // an open object, such as a provider response: only the fields a
  // caller then decodes are its contract
  fields(v: JsonValue | undefined, where: string): JsonFields {
    if (v?.kind !== "object") return this.fail(where, "expected an object");

    return v.fields;
  }

  array(v: JsonValue | undefined, where: string, max = Infinity): readonly JsonValue[] {
    if (v?.kind !== "array") return this.fail(where, "expected an array");

    if (v.items.length > max)
      this.fail(where, `at most ${max} entries are supported (got ${v.items.length})`);

    return v.items;
  }

  string(v: JsonValue | undefined, where: string): string {
    if (v?.kind !== "string") return this.fail(where, "expected a string");

    return v.value;
  }

  boolean(v: JsonValue | undefined, where: string): boolean {
    if (v?.kind !== "boolean") return this.fail(where, "expected true or false");

    return v.value;
  }

  number(v: JsonValue | undefined, where: string): number {
    if (v?.kind !== "number") return this.fail(where, "expected a number");

    return v.value;
  }

  // a non-negative safe integer
  count(v: JsonValue | undefined, where: string): number {
    const n = this.number(v, where);

    if (!Number.isSafeInteger(n) || n < 0) this.fail(where, "expected a non-negative integer");

    return n;
  }

  oneOf<T extends string>(v: JsonValue | undefined, where: string, allowed: readonly T[]): T {
    const found = v?.kind === "string" ? allowed.find((a) => a === v.value) : undefined;

    if (found === undefined)
      return this.fail(where, `expected one of ${allowed.map((a) => `"${a}"`).join(", ")}`);

    return found;
  }
}
