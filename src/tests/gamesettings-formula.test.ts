import { expect, test } from "bun:test";
import { compileFormula, MAX_FORMULA_LENGTH } from "../systems/gamesettings/formula";

function run(text: string, level: number): number {
  const r = compileFormula(text);
  if (!r.ok) throw new Error(r.error);
  return r.fn(level);
}

test("compiles today's XP curve", () => {
  const r = compileFormula("100 * 1.1 ^ (level - 1)");
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.fn(1)).toBe(100);
  expect(Math.floor(r.fn(10))).toBe(Math.floor(100 * 1.1 ** 9));
});

test("numbers allow decimals and whitespace is ignored", () => {
  expect(run("  .5 + 1.5 ", 1)).toBe(2);
});

test("^ is right-associative and binds tighter than unary minus", () => {
  expect(run("-2 ^ 2", 1)).toBe(-4);
  expect(run("2 ^ 3 ^ 2", 1)).toBe(512);
  expect(run("2 ^ -1", 1)).toBe(0.5);
});

test("precedence of + - * / and parentheses", () => {
  expect(run("2 + 3 * 4", 1)).toBe(14);
  expect(run("(2 + 3) * 4", 1)).toBe(20);
  expect(run("10 - 4 - 3", 1)).toBe(3);
  expect(run("level / 2", 5)).toBe(2.5);
});

test("functions", () => {
  expect(run("max(1, level)", 5)).toBe(5);
  expect(run("min(9, level, 7)", 5)).toBe(5);
  expect(run("floor(level / 2)", 5)).toBe(2);
  expect(run("ceil(level / 2)", 5)).toBe(3);
  expect(run("round(2.5)", 1)).toBe(3);
  expect(run("abs(0 - level)", 5)).toBe(5);
  expect(run("pow(level, 2)", 5)).toBe(25);
  expect(run("sqrt(level + 11)", 5)).toBe(4);
  expect(run("log(1)", 1)).toBe(0);
  expect(run("exp(0)", 1)).toBe(1);
});

test("refuses unknown names", () => {
  for (const [text, token] of [
    ["constructor", "constructor"],
    ["process", "process"],
    ["x", "x"],
    ["Math.floor(level)", "Math"],
    ["level()", "level"],
    ["__proto__", "__proto__"],
    ["toString", "toString"],
    ["hasOwnProperty", "hasOwnProperty"],
  ] as const) {
    const r = compileFormula(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(token);
  }
});

test("refuses unary plus", () => {
  expect(compileFormula("+1").ok).toBe(false);
  expect(compileFormula("+level").ok).toBe(false);
});

test("refuses bad arity", () => {
  expect(compileFormula("pow(1)").ok).toBe(false);
  expect(compileFormula("floor(1, 2)").ok).toBe(false);
  expect(compileFormula("max()").ok).toBe(false);
});

test("refuses over 200 characters", () => {
  expect(MAX_FORMULA_LENGTH).toBe(200);
  expect(compileFormula("1+".repeat(100) + "1").ok).toBe(false);
  expect(compileFormula("1".repeat(200)).ok).toBe(true);
});

test("refuses empty", () => {
  expect(compileFormula("").ok).toBe(false);
  expect(compileFormula("   ").ok).toBe(false);
});

test("refuses unbalanced parens and stray input", () => {
  expect(compileFormula("(1 + 2").ok).toBe(false);
  expect(compileFormula("1 + 2)").ok).toBe(false);
  expect(compileFormula("max(1, 2").ok).toBe(false);
  expect(compileFormula("1 2").ok).toBe(false);
  expect(compileFormula("1 + $").ok).toBe(false);
});

test("% works", () => {
  expect(run("level % 3", 7)).toBe(1);
});
