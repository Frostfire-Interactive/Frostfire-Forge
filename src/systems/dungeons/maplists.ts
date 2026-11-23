import { bareName as bare } from "./copykey";

export interface ListCache {
    get(key: string): Promise<any>;
    add(key: string, value: any): Promise<void>;
}

interface Held { maps?: MapData[]; props?: MapProperties[] }

/** Applies a change to the cached lists and publishes those same objects: a cache that hands out a copy per read would lose the change otherwise. */
async function change(cache: ListCache, held: Held, edit: (maps: MapData[], props: MapProperties[]) => void): Promise<void> {
    const maps = (await cache.get("maps")) as MapData[];
    const props = (await cache.get("mapProperties")) as MapProperties[];
    edit(maps, props);
    if (held.maps && held.maps !== maps) edit(held.maps, []);
    if (held.props && held.props !== props) edit([], held.props);
    await cache.add("maps", maps);
    await cache.add("mapProperties", props);
}

/** Adds an entry once; a left-over entry of the same map name is replaced, so the list holds the new copy's. */
function put<T extends { name: string }>(list: T[], entry: T): void {
    if (list.includes(entry)) return;
    const at = list.findIndex((other) => bare(other.name) === bare(entry.name));
    if (at === -1) list.push(entry);
    else list[at] = entry;
}

export function addCopyEntries(cache: ListCache, held: Held, map: MapData, props: MapProperties): Promise<void> {
    return change(cache, held, (maps, list) => {
        put(maps, map);
        put(list, props);
    });
}

export function removeCopyEntries(cache: ListCache, held: Held, key: string): Promise<void> {
    const drop = <T extends { name: string }>(list: T[]) => {
        const at = list.findIndex((entry) => bare(entry.name) === bare(key));
        if (at !== -1) list.splice(at, 1);
    };
    return change(cache, held, (maps, list) => { drop(maps); drop(list); });
}

/** Runs a step for each item; one that throws is reported and the rest still run. Rejects at the end if any failed. */
export async function eachOrReport<T>(items: T[], run: (item: T) => Promise<void> | void, report: (item: T, error: unknown) => void): Promise<void> {
    let failed = 0;
    for (const item of items) {
        try {
            await run(item);
        } catch (error) {
            failed++;
            report(item, error);
        }
    }
    if (failed > 0) throw new Error(`${failed} of ${items.length} failed`);
}
