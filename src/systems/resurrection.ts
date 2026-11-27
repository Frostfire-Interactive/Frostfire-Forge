import playerCache from "../services/playermanager";
import log from "../modules/logger";
import { registerEffectsPayloadProvider } from "./spelleffects";
import { getIconUrl } from "../modules/spriteSheetManager";
import { setting } from "./gamesettings/store";

/** How long resurrection sickness lasts, read when it is given. */
export const sicknessDurationMs = (): number => setting("resSicknessMinutes") * 60 * 1000;
export const sicknessDurationSec = (): number => setting("resSicknessMinutes") * 60;
/** The share of max health a sick character keeps (default: 20% reduction). */
export const sicknessHealthMult = (): number => setting("resSicknessHealthMultiplier");
/** The share of every other stat a sick character keeps (default: 10% reduction). */
export const sicknessStatMult = (): number => setting("resSicknessStatMultiplier");

const SICK_EFFECT_ID = "resurrection-sickness";

const expiryTimers = new Map<string, NodeJS.Timeout>();
const sickByUsername = new Map<string, number>();

/** What a sickness was given with: later edits to the settings leave it as it was. */
export type SicknessGiven = { durationMs: number; healthMult: number; statMult: number };
const givenByUsername = new Map<string, SicknessGiven>();

/** The settings as they are now, for a sickness nobody recorded (one restored from the database holds only its end). */
const liveGiven = (): SicknessGiven => ({ durationMs: sicknessDurationMs(), healthMult: sicknessHealthMult(), statMult: sicknessStatMult() });

/** What this player's sickness was given with; the live settings when none was recorded. */
export function sicknessGivenOf(player: any): SicknessGiven {
  return givenByUsername.get(usernameKey(player)) ?? liveGiven();
}

/** Remembers what a sickness arriving from another node was given with. */
export function rememberSicknessGiven(username: string, given: SicknessGiven | null | undefined): void {
  const key = String(username || "").toLowerCase();
  if (key && given) givenByUsername.set(key, { ...given });
}
let onExpiry: ((player: any) => void) | null = null;

export function setOnSicknessExpiry(fn: (player: any) => void): void {
  onExpiry = fn;
}

export function isSick(player: any): boolean {
  const until = Number(player?.resurrectionSickUntil) || 0;
  return until > 0 && Date.now() < until;
}

export function sicknessRemainingSec(player: any): number {
  const until = Number(player?.resurrectionSickUntil) || 0;
  return Math.max(0, Math.ceil((until - Date.now()) / 1000));
}

export function applySicknessToStats(stats: any, player?: any): any {
  if (!stats) return stats;
  const given = player ? sicknessGivenOf(player) : liveGiven();
  stats.total_max_health = Math.max(
    1,
    Math.floor((stats.total_max_health || 0) * given.healthMult)
  );
  stats.total_max_stamina = Math.max(
    1,
    Math.floor((stats.total_max_stamina || 0) * given.statMult)
  );
  for (const key of [
    "stat_damage",
    "stat_armor",
    "stat_critical_chance",
    "stat_critical_damage",
    "stat_avoidance",
  ]) {
    stats[key] = Math.floor((stats[key] || 0) * given.statMult);
  }
  stats.health = Math.min(stats.health ?? 0, stats.total_max_health);
  stats.stamina = Math.min(stats.stamina ?? 0, stats.total_max_stamina);
  return stats;
}

function usernameKey(player: any): string {
  return String(player?.username || "").toLowerCase();
}

function scheduleExpiry(player: any): void {
  const key = String(player.id);
  const existing = expiryTimers.get(key);
  if (existing) {
    clearTimeout(existing);
    expiryTimers.delete(key);
  }
  const until = Number(player.resurrectionSickUntil || 0);
  const remaining = until - Date.now();
  if (remaining <= 0) return;
  const timer = setTimeout(() => {
    expiryTimers.delete(key);
    const mapped = sickByUsername.get(usernameKey(player));
    if (mapped && mapped <= Date.now()) {
      sickByUsername.delete(usernameKey(player));
      givenByUsername.delete(usernameKey(player));
    }
    const fresh = playerCache.get(player.id);
    if (!fresh || !fresh.resurrectionSickUntil) return;
    if (Date.now() < fresh.resurrectionSickUntil) return;
    fresh.resurrectionSickUntil = 0;
    playerCache.set(fresh.id, fresh);
    if (onExpiry) {
      try {
        onExpiry(fresh);
      } catch (e: any) {
        log.error(`Resurrection sickness expiry handler failed: ${e?.message || e}`);
      }
    }
  }, remaining);
  expiryTimers.set(key, timer);
}

export function applySickness(player: any): number {
  const given = liveGiven();
  const until = Date.now() + given.durationMs;
  givenByUsername.set(usernameKey(player), given);
  player.resurrectionSickUntil = until;
  playerCache.set(player.id, player);
  sickByUsername.set(usernameKey(player), until);
  scheduleExpiry(player);
  return until;
}

export function clearSickness(player: any): void {
  const timer = expiryTimers.get(String(player.id));
  if (timer) {
    clearTimeout(timer);
    expiryTimers.delete(String(player.id));
  }
  sickByUsername.delete(usernameKey(player));
  givenByUsername.delete(usernameKey(player));
  player.resurrectionSickUntil = 0;
  playerCache.set(player.id, player);
}

export function saveOnDisconnect(player: any): void {
  const key = usernameKey(player);
  if (!key) return;
  if (isSick(player)) {
    sickByUsername.set(key, Number(player.resurrectionSickUntil));
  } else {
    sickByUsername.delete(key);
    givenByUsername.delete(key);
  }
}

export function forgetSickness(player: any): void {
  const key = String(player?.id);
  const timer = expiryTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    expiryTimers.delete(key);
  }
  sickByUsername.delete(usernameKey(player));
  givenByUsername.delete(usernameKey(player));
}

export function restoreOnLogin(cachedPlayer: any): boolean {
  const key = usernameKey(cachedPlayer);
  if (!key) return false;
  const until = Number(sickByUsername.get(key)) || 0;
  if (until <= Date.now()) {
    sickByUsername.delete(key);
    givenByUsername.delete(key);
    cachedPlayer.resurrectionSickUntil = 0;
    return false;
  }
  cachedPlayer.resurrectionSickUntil = until;
  playerCache.set(cachedPlayer.id, cachedPlayer);
  scheduleExpiry(cachedPlayer);
  applySicknessToStats(cachedPlayer.stats, cachedPlayer);
  return true;
}

registerEffectsPayloadProvider((player: any) => {
  if (!isSick(player)) return [];
  const given = sicknessGivenOf(player);
  return [
    {
      id: SICK_EFFECT_ID,
      spell: "Resurrection Sickness",
      kind: "sickness",
      duration: Math.round(given.durationMs / 1000),
      remaining: sicknessRemainingSec(player),
      description: `-${Math.round((1 - given.healthMult) * 100)}% max health, -${Math.round((1 - given.statMult) * 100)}% all other stats`,
      icon: getIconUrl("skeleton"),
      isDebuff: true,
    },
  ];
});
