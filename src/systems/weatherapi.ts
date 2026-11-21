import log from "../modules/logger";

export const WEATHER_API = "weather_api";

/** What the client is told a reading looks like: weathers it draws by name. */
export type Look = "clear" | "rainy" | "snowy" | "thunderstorm" | "sandstorm" | "fog";

const ENDPOINT = "https://api.openweathermap.org/data/2.5/weather";
/** OpenWeatherMap renews a place's reading about every ten minutes. */
const DEFAULT_MINUTES = 10;
const TIMEOUT_MS = 10_000;
const SNOW_WEIGHT = 3;
/** Wind slower than this (mph) has no direction worth showing. */
const CALM = 1;
export const SANDSTORM_WIND = CALM;
const SAND_CONDITIONS = [731, 751, 761];
const FOG_CONDITIONS = [701, 741];

/** The weather until the first reading, and with no key or place to read: a still, clear day. */
const STILL: WeatherData = { name: WEATHER_API, temperature: 68, humidity: 30, wind_speed: 0, wind_direction: "none", precipitation: 0, ambience: 0 };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const finite = (value: unknown, otherwise: number) => (typeof value === "number" && Number.isFinite(value) ? value : otherwise);

/** What a condition id of OpenWeatherMap looks like: 2xx thunderstorm, 3xx drizzle, 5xx rain, 6xx snow, the rest dry. */
function lookOfCondition(id: number): Look {
  if (id >= 200 && id < 300) return "thunderstorm";
  if ((id >= 300 && id < 400) || (id >= 500 && id < 600)) return "rainy";
  if (id >= 600 && id < 700) return "snowy";
  if (FOG_CONDITIONS.includes(id)) return "fog";
  return "clear";
}

function fallOf(mmPerHour: number | null, id: number): number {
  if (mmPerHour !== null && mmPerHour > 0) return clamp(Math.round(100 * (1 - Math.exp(-mmPerHour / 4))), 5, 100);
  const step = id % 10;
  return step === 0 ? 20 : step === 1 ? 50 : 85;
}

function directionOf(degFrom: number, speed: number): string {
  if (speed < CALM) return "none";
  const to = (((degFrom + 180) % 360) + 360) % 360;
  if (to >= 45 && to < 135) return "right";
  if (to >= 135 && to < 225) return "down";
  if (to >= 225 && to < 315) return "left";
  return "up";
}

export function readingToWeather(body: any): { row: WeatherData; look: Look; utcOffset: number | null } | null {
  const temperature = body?.main?.temp;
  if (typeof temperature !== "number" || !Number.isFinite(temperature)) return null;
  // The place's shift from UTC in seconds, daylight saving included: no zone is further than 14 hours out.
  const shift = body?.timezone;
  const utcOffset = typeof shift === "number" && Number.isFinite(shift) && Math.abs(shift) <= 14 * 3600 ? Math.round(shift) : null;
  const id = finite(body?.weather?.[0]?.id, 800);
  const speed = Math.max(0, finite(body?.wind?.speed, 0));
  const dry = lookOfCondition(id);
  const look: Look = dry === "clear" && (speed >= SANDSTORM_WIND || SAND_CONDITIONS.includes(id)) ? "sandstorm" : dry;
  const amount = Math.max(0, finite(body?.rain?.["1h"], 0)) + Math.max(0, finite(body?.snow?.["1h"], 0)) * SNOW_WEIGHT;
  const precipitation = look === "clear" || look === "sandstorm" || look === "fog" ? 0 : fallOf(amount > 0 ? amount : null, id);
  const clouds = clamp(finite(body?.clouds?.all, 0), 0, 100) / 100;
  // The sky darkens with what falls, most in a thunderstorm; dry, only as far as its clouds.
  const ambience = look === "thunderstorm" ? 0.8 : look === "clear" || look === "sandstorm" || look === "fog" ? clouds * 0.3 : 0.3 + precipitation / 100 * 0.3;
  return {
    look,
    utcOffset,
    row: {
      name: WEATHER_API,
      temperature: Math.round(clamp(temperature, -100, 200)),
      humidity: Math.round(clamp(finite(body?.main?.humidity, 0), 0, 100)),
      wind_speed: Math.round(clamp(speed, 0, 100)),
      wind_direction: directionOf(finite(body?.wind?.deg, 0), speed),
      precipitation,
      ambience: Math.round(ambience * 100) / 100,
    },
  };
}

/** The last reading: the one weather every world on "weather_api" shows. */
let held: { row: WeatherData; look: Look } = { row: { ...STILL }, look: "clear" };

/** The place's shift from UTC in seconds, from the last reading that gave one. Null until then. */
let utcOffset: number | null = null;

export function utcOffsetSeconds(): number | null {
  return utcOffset;
}

/** The values of "weather_api" now, as a weather of the table would carry them. */
export function currentWeather(): WeatherData {
  return held.row;
}

export function shownAs(name: string): string {
  return name === WEATHER_API ? held.look : name;
}

export function locationQuery(location: string | undefined): string | null {
  const place = String(location ?? "").trim();
  if (!place) return null;
  const pair = place.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (pair) return `lat=${pair[1]}&lon=${pair[2]}`;
  return `q=${encodeURIComponent(place)}`;
}

const COLUMNS = ["temperature", "humidity", "wind_speed", "wind_direction", "precipitation", "ambience"] as const;

type Fetcher = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

export type Refresh = "off" | "failed" | "same" | "changed";

/** The last failure logged, so that a place or a key that stays wrong is reported once, not every few minutes. */
let lastFailure = "";

function failed(reason: string): Refresh {
  if (reason !== lastFailure) log.warn(`Weather API: ${reason}. "${WEATHER_API}" keeps its last reading.`);
  lastFailure = reason;
  return "failed";
}

/** Takes one reading and holds it. "changed" when it differs from the one held, in its values or its look. */
export async function refresh(fetcher: Fetcher = fetch as unknown as Fetcher): Promise<Refresh> {
  const key = String(process.env.WEATHER_API_KEY ?? "").trim();
  const place = locationQuery(process.env.WEATHER_API_LOCATION);
  if (!key || !place) return "off";

  let reading: ReturnType<typeof readingToWeather>;
  try {
    // The address carries the key: it is never logged.
    const response = await fetcher(`${ENDPOINT}?${place}&units=imperial&appid=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) {
      const why = response.status === 401 ? "the key was refused (a new key takes up to two hours to work)"
        : response.status === 404 ? "the place in WEATHER_API_LOCATION was not found"
        : response.status === 429 ? "too many requests for this key"
        : `the service answered ${response.status}`;
      return failed(why);
    }
    reading = readingToWeather(await response.json());
  } catch (error) {
    return failed(`no reading (${(error as Error)?.name === "TimeoutError" ? "timed out" : (error as Error)?.message ?? error})`);
  }
  if (!reading) return failed("the answer was not a weather reading");
  lastFailure = "";
  if (reading.utcOffset !== null) utcOffset = reading.utcOffset;

  const before = held;
  if (before.look === reading.look && COLUMNS.every((column) => before.row[column] === reading.row[column])) return "same";
  held = { row: reading.row, look: reading.look };
  log.debug(`Weather API: ${reading.look}, ${reading.row.temperature}F, wind ${reading.row.wind_speed} mph ${reading.row.wind_direction}, precipitation ${reading.row.precipitation}`);
  return "changed";
}

let timer: ReturnType<typeof setInterval> | null = null;

export async function startWeatherApi(onChange: (row: WeatherData) => void, onClock: (utcOffset: number) => void = () => {}): Promise<void> {
  if (!String(process.env.WEATHER_API_KEY ?? "").trim() || !locationQuery(process.env.WEATHER_API_LOCATION)) {
    log.info(`Weather API: off (set WEATHER_API_KEY and WEATHER_API_LOCATION to have "${WEATHER_API}" follow a real place)`);
    return;
  }
  const minutes = Math.max(1, Number(process.env.WEATHER_API_MINUTES) || DEFAULT_MINUTES);
  const read = async () => {
    try {
      const clock = utcOffset;
      const result = await refresh();
      if (utcOffset !== null && utcOffset !== clock) onClock(utcOffset);
      if (result === "changed") onChange(currentWeather());
    } catch (error) {
      log.error(`Weather API: ${error}`);
    }
  };
  if (timer) clearInterval(timer);
  timer = setInterval(read, minutes * 60_000);
  timer.unref?.();
  log.info(`Weather API: following ${String(process.env.WEATHER_API_LOCATION).trim()}, read every ${minutes} minute${minutes === 1 ? "" : "s"}`);
  await read();
}

/** For tests: forget the last reading. */
export function resetWeatherApi(): void {
  held = { row: { ...STILL }, look: "clear" };
  utcOffset = null;
  lastFailure = "";
  if (timer) clearInterval(timer);
  timer = null;
}
