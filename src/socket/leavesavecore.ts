// What a player who leaves keeps for their next login, saved the same way whether they disconnect (server.ts
// onDisconnect) or a newer login of their account kicks them (server.ts saveKickedPlayer): the effects on them
// (damage over time, barriers, stuns, slows), their sickness, then their stats and where they stand.
//
// Made of what it saves through, handed in: socket/leavesave.ts hands in the server's own modules, and the tests that
// run server.ts's leave code from its source hand in their stand-ins (tests/setup.ts withLeaveSaves), so both run this.

/** What the leave saves are written through. */
export interface LeaveSaveDeps {
  effectManager: {
    saveDots(username: string, dots: any[]): unknown;
    saveBarriers(username: string, barriers: any[]): unknown;
    saveStuns(username: string, stuns: any[]): unknown;
    saveSlows(username: string, slows: any[]): unknown;
  };
  dots: { getPlayerDots(playerId: string): any[] | undefined | null };
  getStunsForPlayer(playerId: string): any[] | undefined | null;
  getSlowsForPlayer(playerId: string): any[] | undefined | null;
  saveSicknessOnDisconnect(p: any): unknown;
  player: {
    setStats(who: any, stats: any): Promise<unknown>;
    setLocation(sessionId: string, map: string, position: any, who?: any): Promise<unknown>;
    setLocationByUsername(username: string, map: string, position: any): Promise<unknown>;
  };
}

export interface LeaveSaves {
  /** Saves the effects on a leaving player and their sickness. Nothing for a guest. */
  saveLeavingEffects(p: any): void;
  /**
   * Saves a leaving player's stats and location without the owner-epoch fence. `bySession`: the location goes by the
   * player's session id, so a session another login has taken since writes none (a disconnect). Otherwise it goes by
   * the character (a kick: the new login has claimed the session already). Nothing for a guest.
   */
  saveLeavingState(p: any, bySession: boolean): Promise<void>;
}

export function leaveSaves(deps: LeaveSaveDeps): LeaveSaves {
  return {
    saveLeavingEffects(p: any): void {
      if (!p || p.isGuest) return;
      const username = p.username?.toLowerCase();
      if (!username) return;
      deps.effectManager.saveDots(username, deps.dots.getPlayerDots(String(p.id)) || []);
      deps.effectManager.saveBarriers(username, p.barriers || []);
      deps.effectManager.saveStuns(username, deps.getStunsForPlayer(String(p.id)) || []);
      deps.effectManager.saveSlows(username, deps.getSlowsForPlayer(String(p.id)) || []);
      deps.saveSicknessOnDisconnect(p);
    },
    async saveLeavingState(p: any, bySession: boolean): Promise<void> {
      if (!p || p.isGuest) return;
      if (p.stats) await deps.player.setStats(p, p.stats);
      if (!p.location?.map || !p.location?.position) return;
      if (bySession) {
        if (p.id) await deps.player.setLocation(p.id, p.location.map, p.location.position, p);
      } else if (p.username) {
        await deps.player.setLocationByUsername(p.username, p.location.map, p.location.position);
      }
    },
  };
}
