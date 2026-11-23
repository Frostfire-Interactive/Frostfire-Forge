export const COPY_SEP = "~";

const JSON_EXT = ".json";

const split = (map: string): { base: string; ext: string } => {
    const hasExt = map.endsWith(JSON_EXT);
    return { base: hasExt ? map.slice(0, -JSON_EXT.length) : map, ext: hasExt ? JSON_EXT : "" };
};

/** Key of one copy of a template map: bare template name, separator, lowercase copy id. */
export function copyKey(template: string, copyId: string): string {
    return `${split(template).base}${COPY_SEP}${copyId.toLowerCase()}`;
}

/** A map name without its .json suffix; a missing name is empty. */
export function bareName(map: string): string {
    return split(String(map ?? "")).base;
}

export function isCopyKey(map: string): boolean {
    return split(map).base.includes(COPY_SEP);
}

/** Bare template name, without the copy segment or the .json suffix. */
export function templateOf(map: string): string {
    const { base } = split(map);
    const i = base.indexOf(COPY_SEP);
    return i === -1 ? base : base.slice(0, i);
}

/** The map name the client knows: copy segment removed, .json suffix kept if present. */
export function clientMapName(map: string): string {
    const { ext } = split(map);
    return `${templateOf(map)}${ext}`;
}

export function newCopyId(n: number): string {
    return Math.floor(n).toString(36);
}
