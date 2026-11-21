/** The kinds of sound a weather has, in the order the editor shows them. */
export const SOUND_KINDS = ["rain", "wind", "thunder"] as const;
export type SoundKind = (typeof SOUND_KINDS)[number];

/** What each kind is heard by, as the editor is sent it: a ranged kind's range is held to min and max. */
export interface SoundKindRule {
  label: string;
  /** False for a kind whose sounds have no range (thunder): the rest of the rule is absent. */
  ranged: boolean;
  /** What `from` and `to` measure, in words. */
  measure?: string;
  unit?: string;
  min?: number;
  max?: number;
}

export const SOUND_RULES: Record<SoundKind, SoundKindRule> = {
  rain: { label: "Rain", ranged: true, measure: "Precipitation", unit: "%", min: 0, max: 100 },
  // A gust adds up to half the wind speed again (the client's calculateWindSpeed): the top of the editor's 100 mph.
  wind: { label: "Wind", ranged: true, measure: "Wind speed", unit: "mph", min: 0, max: 150 },
  thunder: { label: "Thunder", ranged: false },
};

/** How many sounds one kind may hold. */
export const SOUNDS_MAX = 12;
/** How long a sound's name may be. */
export const SOUND_NAME_MAX = 100;

const NONE = (): WeatherSounds => ({ rain: [], wind: [], thunder: [] });

const RAIN: WeatherSound[] = [
  { name: "soft rain", from: 0, to: 75, volume: 1 },
  { name: "hard rain", from: 35, to: 100, volume: 1 },
];
const WIND: WeatherSound[] = [
  { name: "gentle wind 2", from: 0, to: 12, volume: 1 },
  { name: "gentle wind", from: 6, to: 26, volume: 1 },
  { name: "regular wind", from: 18, to: 150, volume: 1 },
];
const THUNDER: WeatherThunder[] = [
  { name: "thunder", volume: 1 },
  { name: "thunder 2", volume: 1 },
  { name: "thunder 3", volume: 1 },
];
export const DEFAULT_SOUNDS: Record<string, WeatherSounds> = {
  clear: { rain: [], wind: WIND, thunder: [] },
  darkness: { rain: [], wind: WIND, thunder: [] },
  rainy: { rain: RAIN, wind: WIND, thunder: [] },
  snowy: { rain: [], wind: WIND, thunder: [] },
  sandstorm: { rain: [], wind: WIND, thunder: [] },
  thunderstorm: { rain: RAIN, wind: WIND, thunder: THUNDER },
  tornado: { rain: RAIN, wind: WIND, thunder: THUNDER },
};

export function parseSounds(raw: unknown): WeatherSounds {
  let value: any = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return NONE();
    }
  }
  const sounds = NONE();
  if (!value || typeof value !== "object") return sounds;
  for (const kind of SOUND_KINDS) {
    const list = Array.isArray(value[kind]) ? value[kind] : [];
    for (const entry of list) {
      const name = typeof entry?.name === "string" ? entry.name.trim() : "";
      if (!name) continue;
      const read = Number(entry?.volume ?? 1);
      const volume = Number.isFinite(read) ? read : 1;
      if (kind === "thunder") {
        sounds.thunder.push({ name, volume });
        continue;
      }
      const from = Number(entry?.from), to = Number(entry?.to);
      if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
      sounds[kind].push({ name, from, to, volume });
    }
  }
  return sounds;
}

/** The column's text for a weather's sounds. */
export function soundsText(sounds: WeatherSounds | null | undefined): string {
  return JSON.stringify(parseSounds(sounds ?? null));
}

export function validateSounds(data: any): Array<{ field: string; message: string }> {
  const errors: Array<{ field: string; message: string }> = [];
  if (data === undefined || data === null) return errors;
  if (typeof data !== "object" || Array.isArray(data)) return [{ field: "sounds", message: "Sounds must be a list for each of rain, wind and thunder." }];
  for (const kind of SOUND_KINDS) {
    const rule = SOUND_RULES[kind];
    const list = data[kind];
    if (list === undefined || list === null) continue;
    if (!Array.isArray(list)) {
      errors.push({ field: `sounds.${kind}`, message: `${rule.label} sounds must be a list.` });
      continue;
    }
    if (list.length > SOUNDS_MAX) errors.push({ field: `sounds.${kind}`, message: `A weather can have at most ${SOUNDS_MAX} ${rule.label.toLowerCase()} sounds.` });
    list.forEach((entry: any, i: number) => {
      const at = `sounds.${kind}.${i}`;
      const name = typeof entry?.name === "string" ? entry.name.trim() : "";
      if (!name) errors.push({ field: `${at}.name`, message: "Pick an audio file." });
      else if (name.length > SOUND_NAME_MAX) errors.push({ field: `${at}.name`, message: `An audio name must be ${SOUND_NAME_MAX} characters or fewer.` });
      if (rule.ranged) {
        const { min = 0, max = 0 } = rule;
        const ends: Array<["from" | "to", string]> = [["from", "From"], ["to", "To"]];
        for (const [key, label] of ends) {
          const value = entry?.[key];
          if (typeof value !== "number" || !Number.isFinite(value)) errors.push({ field: `${at}.${key}`, message: `${label} must be a number.` });
          else if (value < min || value > max) errors.push({ field: `${at}.${key}`, message: `${label} must be between ${min} and ${max}.` });
        }
        if (typeof entry?.from === "number" && typeof entry?.to === "number" && entry.from > entry.to) {
          errors.push({ field: `${at}.to`, message: "To must not be under From." });
        }
      }
      const volume = entry?.volume;
      if (typeof volume !== "number" || !Number.isFinite(volume)) errors.push({ field: `${at}.volume`, message: "Volume must be a number." });
      else if (volume < 0 || volume > 1) errors.push({ field: `${at}.volume`, message: "Volume must be between 0 and 1." });
    });
  }
  return errors;
}
