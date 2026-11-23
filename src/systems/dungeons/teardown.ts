import log from "../../modules/logger";

export interface TeardownSteps { [step: string]: () => Promise<void> | void }

export const TEARDOWN_ORDER = [
    "movePlayersOut", "despawnCreatures", "despawnChests", "despawnGroundLoot", "despawnSkeletons", "clearGroundAoe",
    "clearSpatialGrid", "forgetCaches", "unregisterMap", "unpinCluster", "removeBookRecord",
];

/** Runs the steps in order; one that fails is logged and the rest still run. Returns the failed steps. */
export async function closeCopy(key: string, steps: TeardownSteps): Promise<string[]> {
    const failed: string[] = [];
    for (const name of TEARDOWN_ORDER) {
        const step = steps[name];
        if (!step) continue;
        try {
            await step();
        } catch (error) {
            failed.push(name);
            log.error(`Closing copy ${key}: step ${name} failed: ${error}`);
        }
    }
    return failed;
}
