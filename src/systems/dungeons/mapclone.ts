import { bareName as bare } from "./copykey";

/** A copy's map and properties entries: the template's tile data is shared, its objects are copied. */
export function cloneMapEntries(template: string, key: string, maps: MapData[], props: MapProperties[]): { map: MapData; props: MapProperties } {
  const map = maps.find((m) => bare(m.name) === bare(template));
  const source = props.find((p) => bare(p.name) === bare(template));
  if (!map || !source) throw new Error(`Map ${template} is not loaded`);
  const name = `${bare(key)}.json`;
  const copy = <T>(value: T): T => (value === undefined || value === null ? value : structuredClone(value));
  return {
    map: { ...map, name },
    props: {
      ...source,
      name,
      warps: copy(source.warps),
      graveyards: copy(source.graveyards),
      chests: copy(source.chests),
      dungeonPortals: copy(source.dungeonPortals),
    },
  };
}
