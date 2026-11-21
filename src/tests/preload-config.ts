import { mock } from "bun:test";

const settings = { creatures: {} };
const settingsModule = () => ({ default: settings, ...settings });
mock.module("../config/settings.json", settingsModule);

const aoi = {
  DEFAULT_RADIUS: 1000,
  UPDATE_THRESHOLD: 100,
  GRID_CELL_SIZE: 512,
  USE_SPATIAL_GRID: true,
  SPATIAL_GRID_THRESHOLD: 50,
  MAX_PLAYERS_PER_LAYER: 50,
  DEBUG: false,
};
const aoiModule = () => ({ default: aoi, ...aoi });
mock.module("../config/aoi.json", aoiModule);

/** The stand-ins by the path a test imports them with, for preload.ts to put back when a test file has put its own in place. */
export const configStandIns: Record<string, () => Record<string, any>> = {
  "../config/settings.json": settingsModule,
  "../config/aoi.json": aoiModule,
};
