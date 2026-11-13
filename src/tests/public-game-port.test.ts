import { describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";

const server = fs.readFileSync(path.join(import.meta.dir, "../socket/server.ts"), "utf8");

describe("the WebTransport port a node advertises", () => {
  test("is PUBLIC_GAME_PORT when set (a host port mapped to the game port), else the game port", () => {
    const line = server.split("\n").find((l) => /^const publicGamePort\s*=/.test(l));
    expect(line).toBeDefined();
    const read = new Function("process", "gamePort", `${line!.replace(/^const /, "let ")} return publicGamePort;`);
    expect(read({ env: { PUBLIC_GAME_PORT: "3101" } }, 3000)).toBe(3101);
    expect(read({ env: {} }, 3000)).toBe(3000);
    expect(read({ env: { PUBLIC_GAME_PORT: "" } }, 3000)).toBe(3000);
    expect(read({ env: { PUBLIC_GAME_PORT: "abc" } }, 3000)).toBe(3000);
  });

  test("goes to the gateway and to the cluster, while the server listens on the game port", () => {
    expect(server.match(/wtPort: publicGamePort/g)?.length).toBe(2);
    expect(server).not.toMatch(/wtPort: gamePort/);
  });
});
