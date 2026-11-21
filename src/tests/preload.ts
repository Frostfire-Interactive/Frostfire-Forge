import { configStandIns } from "./preload-config";
import { afterAll, mock } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { databaseModule } from "./setup";

delete process.env.CACHE;
delete process.env.REDIS_URL;
delete process.env.REDIS_PASSWORD;

mkdirSync(join(import.meta.dir, "..", "logs"), { recursive: true });

const baseline = new Map<string, () => Record<string, any>>(Object.entries(configStandIns));
const originalModule = mock.module.bind(mock);
function stand(path: string, factory: () => Record<string, any>): void {
  baseline.set(path, factory);
  originalModule(path, factory);
}
stand("../controllers/sqldatabase", () => databaseModule({ default: async () => [], drainQueries: async () => {} }));

const loadable = new Set(["../services/assetCache", "../services/datacache", "../cluster/redisstore"]);
const real = new Map<string, Record<string, any>>();
(mock as { module: typeof mock.module }).module = (path: string, factory: () => Record<string, any>) => {
  if (!baseline.has(path) && !real.has(path) && loadable.has(path)) {
    try {
      real.set(path, { ...require(path) });
    } catch {
      // not loadable here: the module is left as the file put it
    }
  }
  const back = baseline.get(path) ?? (real.has(path) ? () => real.get(path)! : null);
  if (back) {
    try {
      afterAll(() => { originalModule(path, back); });
    } catch {
      // called where no hook can be set (outside a test file): nothing to undo it with
    }
  }
  return originalModule(path, factory);
};
