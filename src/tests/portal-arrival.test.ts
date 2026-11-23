import { describe, expect, test } from "bun:test";
import { PORTAL_ARRIVAL_MS, cameThroughPortal, markPortalArrival } from "../systems/portalpairs";

describe("portal arrival mark", () => {
  test("a player a portal just put somewhere came through it, for PORTAL_ARRIVAL_MS", () => {
    const p: { portalArrivalAt?: number } = {};
    markPortalArrival(p, 1000);
    expect(cameThroughPortal(p, 1000)).toBe(true);
    expect(cameThroughPortal(p, 1000 + PORTAL_ARRIVAL_MS - 1)).toBe(true);
    expect(cameThroughPortal(p, 1000 + PORTAL_ARRIVAL_MS)).toBe(false);
  });

  test("one who logged in or reconnected (never marked) did not; nor with no player", () => {
    expect(cameThroughPortal({}, 1000)).toBe(false);
    expect(cameThroughPortal(null, 1000)).toBe(false);
    expect(cameThroughPortal(undefined, 1000)).toBe(false);
  });
});
