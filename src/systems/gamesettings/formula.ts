// Safe formula compiler: text in `level` -> closure tree. No eval / new Function.

export const MAX_FORMULA_LENGTH = 200;

type Node = (level: number) => number;
type Token = { kind: "num" | "id" | "op"; text: string; value?: number };
type Result = { ok: true; fn: (level: number) => number } | { ok: false; error: string };

class FormulaError extends Error {}

// [min args, max args, impl]
const FUNCTIONS = new Map<string, [number, number, (...a: number[]) => number]>([
  ["min", [1, Infinity, Math.min]],
  ["max", [1, Infinity, Math.max]],
  ["pow", [2, 2, Math.pow]],
  ["floor", [1, 1, Math.floor]],
  ["ceil", [1, 1, Math.ceil]],
  ["round", [1, 1, Math.round]],
  ["abs", [1, 1, Math.abs]],
  ["sqrt", [1, 1, Math.sqrt]],
  ["log", [1, 1, Math.log]],
  ["exp", [1, 1, Math.exp]],
]);

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
    if ((c >= "0" && c <= "9") || c === ".") {
      const m = /^(?:\d+\.?\d*|\.\d+)/.exec(text.slice(i));
      if (!m) throw new FormulaError(`Unexpected "${c}".`);
      tokens.push({ kind: "num", text: m[0], value: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(text.slice(i))!;
      tokens.push({ kind: "id", text: m[0] });
      i += m[0].length;
      continue;
    }
    if ("+-*/%^(),".includes(c)) {
      tokens.push({ kind: "op", text: c });
      i++;
      continue;
    }
    throw new FormulaError(`Unexpected "${c}".`);
  }
  return tokens;
}

function parse(tokens: Token[]): Node {
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (t: Token | undefined, s: string) => !!t && t.kind === "op" && t.text === s;

  function expect(s: string): void {
    if (!isOp(peek(), s)) {
      const t = peek();
      throw new FormulaError(t ? `Expected "${s}" but found "${t.text}".` : `Expected "${s}" but the formula ended.`);
    }
    pos++;
  }

  function additive(): Node {
    let left = multiplicative();
    for (;;) {
      const t = peek();
      if (isOp(t, "+")) { pos++; const l = left, r = multiplicative(); left = (v) => l(v) + r(v); }
      else if (isOp(t, "-")) { pos++; const l = left, r = multiplicative(); left = (v) => l(v) - r(v); }
      else return left;
    }
  }

  function multiplicative(): Node {
    let left = unary();
    for (;;) {
      const t = peek();
      if (isOp(t, "*")) { pos++; const l = left, r = unary(); left = (v) => l(v) * r(v); }
      else if (isOp(t, "/")) { pos++; const l = left, r = unary(); left = (v) => l(v) / r(v); }
      else if (isOp(t, "%")) { pos++; const l = left, r = unary(); left = (v) => l(v) % r(v); }
      else return left;
    }
  }

  function unary(): Node {
    if (isOp(peek(), "-")) { pos++; const o = unary(); return (v) => -o(v); }
    return power();
  }

  // Right-associative; the exponent may itself carry a unary minus (2 ^ -1).
  function power(): Node {
    const base = primary();
    if (isOp(peek(), "^")) { pos++; const exp = unary(); return (v) => Math.pow(base(v), exp(v)); }
    return base;
  }

  function primary(): Node {
    const t = peek();
    if (!t) throw new FormulaError("The formula ended unexpectedly.");
    pos++;
    if (t.kind === "num") { const n = t.value!; return () => n; }
    if (t.kind === "op") {
      if (t.text === "(") { const inner = additive(); expect(")"); return inner; }
      throw new FormulaError(`Unexpected "${t.text}".`);
    }
    const name = t.text;
    if (name === "level") {
      if (isOp(peek(), "(")) throw new FormulaError(`"level" is a value, not a function.`);
      return (v) => v;
    }
    const fn = FUNCTIONS.get(name);
    if (!fn) throw new FormulaError(`Unknown name "${name}".`);
    if (!isOp(peek(), "(")) throw new FormulaError(`"${name}" must be called like ${name}(...).`);
    pos++;
    const args: Node[] = [];
    if (!isOp(peek(), ")")) {
      args.push(additive());
      while (isOp(peek(), ",")) { pos++; args.push(additive()); }
    }
    expect(")");
    const [lo, hi, impl] = fn;
    if (args.length < lo || args.length > hi) {
      const want = lo === hi ? `${lo}` : `at least ${lo}`;
      throw new FormulaError(`"${name}" takes ${want} argument${lo === 1 && lo === hi ? "" : "s"}, got ${args.length}.`);
    }
    // Fixed arities call straight through; min and max fold pairwise (the same result), so no array is built per call.
    if (args.length === 1) { const a = args[0]!; return (v) => impl(a(v)); }
    if (args.length === 2) { const a = args[0]!, b = args[1]!; return (v) => impl(a(v), b(v)); }
    return (v) => {
      let out = args[0]!(v);
      for (let i = 1; i < args.length; i++) out = impl(out, args[i]!(v));
      return out;
    };
  }

  const root = additive();
  const rest = peek();
  if (rest) throw new FormulaError(`Unexpected "${rest.text}".`);
  return root;
}

export function compileFormula(text: string): Result {
  if (typeof text !== "string" || text.trim() === "") return { ok: false, error: "The formula is empty." };
  if (text.length > MAX_FORMULA_LENGTH) {
    return { ok: false, error: `The formula is longer than ${MAX_FORMULA_LENGTH} characters.` };
  }
  try {
    const root = parse(tokenize(text));
    return { ok: true, fn: (level: number) => root(level) };
  } catch (e) {
    if (e instanceof FormulaError) return { ok: false, error: e.message };
    throw e;
  }
}
