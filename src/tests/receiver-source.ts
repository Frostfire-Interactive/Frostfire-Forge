import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function receiverSource(): string {
  const socket = join(import.meta.dir, "..", "socket");
  const handlers = join(socket, "handlers");
  const parts = [readFileSync(join(socket, "receiver.ts"), "utf8")];
  for (const file of readdirSync(handlers).filter((f) => f.endsWith(".ts")).sort()) {
    parts.push(readFileSync(join(handlers, file), "utf8"));
  }
  return parts.join("\n");
}
