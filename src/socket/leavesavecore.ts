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
