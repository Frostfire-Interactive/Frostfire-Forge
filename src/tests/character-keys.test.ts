import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";
import { CHARACTER_TABLES } from "../utility/charactertables";

const SRC = join(import.meta.dir, "..");

/** Files still holding SQL that keys a character table by `username`. */
const PENDING: readonly string[] = [
  "utility/database_setup.ts",
  "utility/database_setup_sqlite.ts",
  "utility/guild_ranks_migration.ts",
];

function listFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "tests") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) listFiles(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** The string and template literals of a source text (comments skipped). */
function literals(src: string): string[] {
  const out: string[] = [];
  const n = src.length;
  let i = 0;
  const skipQuoted = (q: string, at: number): number => {
    let j = at + 1;
    while (j < n && src[j] !== q && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
    return j + 1;
  };
  const template = (): string => {
    let text = "";
    while (i < n && src[i] !== "`") {
      if (src[i] === "\\") { text += src[i] + (src[i + 1] ?? ""); i += 2; continue; }
      if (src[i] === "$" && src[i + 1] === "{") {
        i += 2;
        let depth = 1;
        while (i < n && depth > 0) {
          const c = src[i];
          if (c === "{") depth++;
          else if (c === "}") depth--;
          else if (c === "`") { i++; out.push(template()); continue; }
          else if (c === '"' || c === "'") { i = skipQuoted(c, i); continue; }
          i++;
        }
        continue;
      }
      text += src[i++];
    }
    i++;
    return text;
  };
  while (i < n) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") i++; }
    else if (c === "/" && src[i + 1] === "*") { i += 2; while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; }
    else if (c === '"' || c === "'") { const end = skipQuoted(c, i); out.push(src.slice(i + 1, end - 1)); i = end; }
    else if (c === "`") { i++; out.push(template()); }
    else i++;
  }
  return out;
}

const TABLE_WORDS = CHARACTER_TABLES.map((t) => new RegExp("(?<![\\w-])" + t + "(?![\\w-])", "i"));

/** Files with SQL naming a character table together with `username`, and how many literals. */
function scan(): Map<string, number> {
  const found = new Map<string, number>();
  for (const file of listFiles(SRC)) {
    let count = 0;
    for (const text of literals(readFileSync(file, "utf8"))) {
      if (/\busername\b/i.test(text) && TABLE_WORDS.some((re) => re.test(text))) count++;
    }
    if (count) found.set(relative(SRC, file).split(sep).join("/"), count);
  }
  return found;
}

describe("character keys ratchet", () => {
  test("every file with character-table SQL on username is in PENDING", () => {
    const unlisted = [...scan().keys()].filter((f) => !PENDING.includes(f));
    expect(unlisted).toEqual([]);
  });

  test("ratchet lists no file that is already clean", () => {
    const found = scan();
    expect(PENDING.filter((f) => !found.has(f))).toEqual([]);
  });

  test("CHARACTER_TABLES holds the character tables", () => {
    expect(CHARACTER_TABLES.length).toBe(20);
    expect(CHARACTER_TABLES).toContain("inventory");
    expect(CHARACTER_TABLES).not.toContain("accounts");
  });
});
