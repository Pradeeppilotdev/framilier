import { z } from "zod";

/** One sidecar instance the explorer can read from. `url` is its JSON-RPC endpoint and identifies it. */
export interface Instance {
  name: string;
  url: string;
  /** Set for the instances the site itself is configured with: always listed first, never saved, cannot be renamed or removed. */
  pinned?: boolean;
}

export interface InstancesState {
  instances: Instance[];
  selectedUrl: string | null;
}

export type InstancesAction =
  | { type: "add"; instance: Instance }
  | { type: "rename"; url: string; name: string }
  | { type: "remove"; url: string }
  | { type: "select"; url: string };

export const STORAGE_KEY = "frame-explorer/instances/v1";

export function instancesReducer(state: InstancesState, action: InstancesAction): InstancesState {
  switch (action.type) {
    case "add": {
      if (state.instances.some((i) => i.url === action.instance.url)) return state;
      return {
        instances: [...state.instances, action.instance],
        selectedUrl: state.selectedUrl ?? action.instance.url,
      };
    }
    case "rename": {
      const name = action.name.trim();
      if (name === "" || state.instances.some((i) => i.url === action.url && i.pinned)) return state;
      return {
        ...state,
        instances: state.instances.map((i) => (i.url === action.url ? { ...i, name } : i)),
      };
    }
    case "remove": {
      if (state.instances.some((i) => i.url === action.url && i.pinned)) return state;
      const instances = state.instances.filter((i) => i.url !== action.url);
      const selectedUrl =
        state.selectedUrl === action.url ? (instances[0]?.url ?? null) : state.selectedUrl;
      return { instances, selectedUrl };
    }
    case "select":
      return state.instances.some((i) => i.url === action.url)
        ? { ...state, selectedUrl: action.url }
        : state;
  }
}

export type UrlCheck = { ok: true; url: string } | { ok: false; error: string };

/**
 * Accepts `https://host`, `http://host:14337` or a full `.../rpc` URL. An
 * address with no path gets `/rpc`, which is where the sidecar serves JSON-RPC.
 */
export function normalizeUrl(input: string): UrlCheck {
  const trimmed = input.trim();
  if (trimmed === "") return { ok: false, error: "Enter the node's URL." };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: "That doesn't look like a URL. Start it with http:// or https://." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "Use an http:// or https:// URL." };
  }
  const path = parsed.pathname.replace(/\/+$/, "");
  return { ok: true, url: `${parsed.origin}${path === "" ? "/rpc" : path}` };
}

export type NewInstanceCheck = { ok: true; instance: Instance } | { ok: false; error: string };

export function validateNewInstance(
  state: InstancesState,
  name: string,
  urlInput: string,
): NewInstanceCheck {
  const checked = normalizeUrl(urlInput);
  if (!checked.ok) return checked;
  if (state.instances.some((i) => i.url === checked.url)) {
    return { ok: false, error: "That instance is already in the list." };
  }
  const trimmed = name.trim();
  return {
    ok: true,
    instance: { name: trimmed === "" ? new URL(checked.url).host : trimmed, url: checked.url },
  };
}

/** `http://host/rpc` becomes `ws://host/rpc`; `https` becomes `wss`. */
export function wsUrl(rpcUrl: string): string {
  const url = new URL(rpcUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

const StoredSchema = z.object({
  instances: z.array(z.object({ name: z.string(), url: z.string() })),
  selectedUrl: z.string().nullable(),
});

/** Normalizes every url, drops the ones that fail and dedupes by normalized url (first wins). */
function cleanInstances(items: Instance[]): Instance[] {
  const seen = new Set<string>();
  const cleaned: Instance[] = [];
  for (const item of items) {
    const checked = normalizeUrl(item.url);
    if (!checked.ok || seen.has(checked.url)) continue;
    seen.add(checked.url);
    cleaned.push({ ...item, url: checked.url });
  }
  return cleaned;
}

export function fallbackState(defaults: Instance[]): InstancesState {
  return { instances: defaults, selectedUrl: defaults[0]?.url ?? null };
}

/**
 * Reads the saved list of the user's own instances. `pinned` (the site's
 * configured instances) always come first and win over a saved copy of the same
 * url, so changing the configuration takes effect for returning visitors.
 * `defaults` are used only when there are no pinned instances and nothing valid
 * was saved.
 */
export function loadState(
  storage: Pick<Storage, "getItem"> | undefined,
  defaults: Instance[],
  pinned: Instance[] = [],
): InstancesState {
  const pins = cleanInstances(pinned.map((i) => ({ ...i, pinned: true })));
  const fallback = () => fallbackState(pins.length > 0 ? pins : defaults);
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return fallback();
    const parsed = StoredSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return fallback();
    const stored = parsed.data;
    const own = cleanInstances(stored.instances);
    // A list that held entries but none valid is corrupt; an empty list is a deliberate choice.
    if (own.length === 0 && stored.instances.length > 0) return fallback();
    const instances = cleanInstances([...pins, ...own]);
    const selected = stored.selectedUrl === null ? null : normalizeUrl(stored.selectedUrl);
    return {
      instances,
      selectedUrl:
        selected?.ok && instances.some((i) => i.url === selected.url)
          ? selected.url
          : (instances[0]?.url ?? null),
    };
  } catch {
    return fallback();
  }
}

export function saveState(storage: Pick<Storage, "setItem"> | undefined, state: InstancesState): void {
  try {
    // Pinned instances come from the site's configuration on every load, so only the user's own are saved.
    const own = state.instances.filter((i) => !i.pinned).map(({ name, url }) => ({ name, url }));
    storage?.setItem(STORAGE_KEY, JSON.stringify({ instances: own, selectedUrl: state.selectedUrl }));
  } catch {
    // Storage can be blocked or full; the list still works for this visit.
  }
}

/** The instances `VITE_EXPLORER_INSTANCES` (a JSON array of `{name, url}`) configures; empty when unset or invalid. */
export function configuredInstances(configured?: string): Instance[] {
  if (!configured) return [];
  try {
    const parsed = z
      .array(z.object({ name: z.string(), url: z.string() }))
      .safeParse(JSON.parse(configured));
    return parsed.success ? cleanInstances(parsed.data) : [];
  } catch {
    return [];
  }
}

/** The list shown on a first visit when nothing is pinned: the configured instances, or a local node. */
export function defaultInstances(configured?: string): Instance[] {
  const items = configuredInstances(configured);
  return items.length > 0 ? items : [{ name: "Local node", url: "http://localhost:14337/rpc" }];
}
