import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const commands = readFileSync(join(import.meta.dir, "..", "socket", "handlers", "commands.ts"), "utf8");
const summonMove = readFileSync(join(import.meta.dir, "..", "socket", "summonmove.ts"), "utf8");

/** A case's body, up to the next case label at any indentation. */
function caseBody(source: string, label: string): string {
  const start = source.indexOf(`case "${label}":`);
  expect(start).toBeGreaterThan(-1);
  const from = start + label.length + 8;
  const next = source.slice(from).search(/\n\s*case "/);
  return source.slice(start, next < 0 ? undefined : from + next);
}

test("SUMMON moves through summonMove and keeps no copy of the move", () => {
  const summon = caseBody(commands, "SUMMON");
  expect(summon).toContain("summonMove(");
  expect(summon).not.toContain("transitionPlayerToMap(");
  expect(summon).not.toContain("resyncNpcChunks(");
});

test("summonMove holds both branches", () => {
  expect(summonMove).toContain("transitionPlayerToMap(");
  expect(summonMove).toContain("destinationLayerFor(");
  expect(summonMove).toContain("resyncNpcChunks(");
});
