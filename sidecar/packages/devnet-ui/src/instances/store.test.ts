import { describe, expect, it } from "vitest";
import {
  STORAGE_KEY,
  configuredInstances,
  defaultInstances,
  instancesReducer,
  loadState,
  normalizeUrl,
  saveState,
  validateNewInstance,
  wsUrl,
  type InstancesState,
} from "./store";

const A = { name: "Devnet", url: "https://altmempool.forshtat.com/rpc" };
const B = { name: "Local", url: "http://localhost:14337/rpc" };
const two: InstancesState = { instances: [A, B], selectedUrl: A.url };

describe("instancesReducer", () => {
  it("adds an instance and selects it when nothing was selected", () => {
    const next = instancesReducer({ instances: [], selectedUrl: null }, { type: "add", instance: A });
    expect(next).toEqual({ instances: [A], selectedUrl: A.url });
  });

  it("ignores a duplicate url", () => {
    expect(instancesReducer(two, { type: "add", instance: { name: "Again", url: A.url } })).toBe(two);
  });

  it("renames, ignoring a blank name", () => {
    expect(instancesReducer(two, { type: "rename", url: B.url, name: "  Mine " }).instances[1]?.name).toBe("Mine");
    expect(instancesReducer(two, { type: "rename", url: B.url, name: "   " })).toBe(two);
  });

  it("moves the selection when the selected instance is removed", () => {
    expect(instancesReducer(two, { type: "remove", url: A.url })).toEqual({
      instances: [B],
      selectedUrl: B.url,
    });
    expect(instancesReducer({ instances: [A], selectedUrl: A.url }, { type: "remove", url: A.url })).toEqual({
      instances: [],
      selectedUrl: null,
    });
  });

  it("keeps the selection when another instance is removed", () => {
    expect(instancesReducer(two, { type: "remove", url: B.url }).selectedUrl).toBe(A.url);
  });

  it("selects only instances that exist", () => {
    expect(instancesReducer(two, { type: "select", url: B.url }).selectedUrl).toBe(B.url);
    expect(instancesReducer(two, { type: "select", url: "http://nope/rpc" })).toBe(two);
  });
});

describe("normalizeUrl", () => {
  it("appends /rpc to a bare origin and strips trailing slashes", () => {
    expect(normalizeUrl("https://altmempool.forshtat.com")).toEqual({
      ok: true,
      url: "https://altmempool.forshtat.com/rpc",
    });
    expect(normalizeUrl(" http://localhost:14337/rpc/ ")).toEqual({
      ok: true,
      url: "http://localhost:14337/rpc",
    });
  });

  it("rejects empty input, non-URLs and other schemes with a reason", () => {
    expect(normalizeUrl("")).toMatchObject({ ok: false });
    expect(normalizeUrl("localhost:14337")).toMatchObject({ ok: false });
    expect(normalizeUrl("ftp://host/rpc")).toEqual({ ok: false, error: "Use an http:// or https:// URL." });
    expect(normalizeUrl("not a url")).toMatchObject({ ok: false });
  });
});

describe("validateNewInstance", () => {
  it("defaults the name to the host", () => {
    expect(validateNewInstance(two, " ", "http://10.0.0.5:14337")).toEqual({
      ok: true,
      instance: { name: "10.0.0.5:14337", url: "http://10.0.0.5:14337/rpc" },
    });
  });

  it("rejects a url that is already listed, even written differently", () => {
    expect(validateNewInstance(two, "x", "http://localhost:14337/rpc/")).toEqual({
      ok: false,
      error: "That instance is already in the list.",
    });
  });
});

describe("wsUrl", () => {
  it("swaps the scheme", () => {
    expect(wsUrl("http://localhost:14337/rpc")).toBe("ws://localhost:14337/rpc");
    expect(wsUrl("https://altmempool.forshtat.com/rpc")).toBe("wss://altmempool.forshtat.com/rpc");
  });
});

describe("persistence", () => {
  const memory = () => {
    const data = new Map<string, string>();
    return {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    };
  };

  it("round-trips the list and selection", () => {
    const storage = memory();
    saveState(storage, two);
    expect(loadState(storage, [B])).toEqual(two);
  });

  it("falls back to defaults for empty, corrupt or invalid storage", () => {
    expect(loadState(memory(), [B])).toEqual({ instances: [B], selectedUrl: B.url });
    const corrupt = memory();
    corrupt.setItem(STORAGE_KEY, "{oops");
    expect(loadState(corrupt, [B]).instances).toEqual([B]);
    const invalid = memory();
    invalid.setItem(STORAGE_KEY, JSON.stringify({ instances: "no" }));
    expect(loadState(invalid, [B]).instances).toEqual([B]);
  });

  it("repairs a selection that points at a missing instance", () => {
    const storage = memory();
    storage.setItem(STORAGE_KEY, JSON.stringify({ instances: [A], selectedUrl: "http://gone/rpc" }));
    expect(loadState(storage, [B]).selectedUrl).toBe(A.url);
  });

  it("normalizes, drops malformed and dedupes stored instances (first wins)", () => {
    const storage = memory();
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        instances: [
          { name: "First", url: "http://localhost:14337/rpc/" },
          { name: "Dupe", url: "http://localhost:14337/rpc" },
          { name: "Bare", url: "https://altmempool.forshtat.com" },
          { name: "Bad", url: "nope" },
          { name: "Script", url: "javascript:x" },
        ],
        selectedUrl: "http://localhost:14337/rpc/",
      }),
    );
    expect(loadState(storage, [A])).toEqual({
      instances: [
        { name: "First", url: "http://localhost:14337/rpc" },
        { name: "Bare", url: "https://altmempool.forshtat.com/rpc" },
      ],
      selectedUrl: "http://localhost:14337/rpc",
    });
  });

  it("falls back to the first instance when the selection was dropped as invalid", () => {
    const storage = memory();
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({ instances: [{ name: "Bad", url: "nope" }, A], selectedUrl: "nope" }),
    );
    expect(loadState(storage, [B])).toEqual({ instances: [A], selectedUrl: A.url });
  });

  it("falls back to the defaults when every stored instance is invalid", () => {
    const storage = memory();
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        instances: [
          { name: "Bad", url: "nope" },
          { name: "Script", url: "javascript:x" },
        ],
        selectedUrl: "nope",
      }),
    );
    expect(loadState(storage, [B])).toEqual({ instances: [B], selectedUrl: B.url });
  });

  it("keeps a deliberately emptied list empty", () => {
    const storage = memory();
    saveState(storage, { instances: [], selectedUrl: null });
    expect(loadState(storage, [B])).toEqual({ instances: [], selectedUrl: null });
  });

  it("survives blocked storage", () => {
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadState(blocked, [B]).instances).toEqual([B]);
    expect(() => saveState(blocked, two)).not.toThrow();
    expect(loadState(undefined, [B]).instances).toEqual([B]);
  });
});

describe("defaultInstances", () => {
  it("uses the configured list, normalizing urls and dropping invalid ones", () => {
    const configured = JSON.stringify([
      { name: "Devnet", url: "https://altmempool.forshtat.com" },
      { name: "Broken", url: "nope" },
    ]);
    expect(defaultInstances(configured)).toEqual([
      { name: "Devnet", url: "https://altmempool.forshtat.com/rpc" },
    ]);
  });

  it("dedupes configured urls that normalize to the same address, first wins", () => {
    const configured = JSON.stringify([
      { name: "One", url: "http://localhost:14337" },
      { name: "Two", url: "http://localhost:14337/rpc/" },
    ]);
    expect(defaultInstances(configured)).toEqual([{ name: "One", url: "http://localhost:14337/rpc" }]);
  });

  it("falls back to a local node", () => {
    expect(defaultInstances(undefined)).toEqual([{ name: "Local node", url: "http://localhost:14337/rpc" }]);
    expect(defaultInstances("{bad json")).toEqual([{ name: "Local node", url: "http://localhost:14337/rpc" }]);
    expect(defaultInstances("[]")).toEqual([{ name: "Local node", url: "http://localhost:14337/rpc" }]);
  });
});

describe("pinned instances (VITE_EXPLORER_INSTANCES)", () => {
  const P1 = { name: "Gateway", url: "https://gw.example/rpc" };
  const P2 = { name: "Miner", url: "https://miner.example/rpc" };
  const pins = [P1, P2];
  const pinned = (i: { name: string; url: string }) => ({ ...i, pinned: true });
  const memory = () => {
    const data = new Map<string, string>();
    return {
      data,
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    };
  };

  it("cannot be removed or renamed", () => {
    const state: InstancesState = { instances: [pinned(P1), B], selectedUrl: P1.url };
    expect(instancesReducer(state, { type: "remove", url: P1.url })).toBe(state);
    expect(instancesReducer(state, { type: "rename", url: P1.url, name: "Mine" })).toBe(state);
    expect(instancesReducer(state, { type: "remove", url: B.url }).instances).toEqual([pinned(P1)]);
  });

  it("come first on a first visit and are selected", () => {
    expect(loadState(memory(), [B], pins)).toEqual({
      instances: [pinned(P1), pinned(P2)],
      selectedUrl: P1.url,
    });
  });

  it("win over a stale saved copy of themselves and stay above the user's own instances", () => {
    const storage = memory();
    // An older build saved the whole list, including what is now pinned, under an old name.
    saveState(storage, {
      instances: [B, { name: "Old miner name", url: "https://miner.example/rpc/" }, A],
      selectedUrl: B.url,
    });
    expect(loadState(storage, [B], pins)).toEqual({
      instances: [pinned(P1), pinned(P2), B, A],
      selectedUrl: B.url,
    });
  });

  it("are picked up when the configuration changes after the list was saved", () => {
    const storage = memory();
    saveState(storage, { instances: [{ name: "Devnet miner", url: "https://miner.example/rpc" }], selectedUrl: null });
    const state = loadState(storage, [B], pins);
    expect(state.instances.map((i) => i.url)).toEqual([P1.url, P2.url]);
    expect(state.instances.every((i) => i.pinned)).toBe(true);
    expect(state.instances[1]?.name).toBe("Miner");
  });

  it("are not written to storage, so only the user's own instances persist", () => {
    const storage = memory();
    saveState(storage, { instances: [pinned(P1), pinned(P2), B], selectedUrl: P2.url });
    const saved = JSON.parse(storage.data.get(STORAGE_KEY) ?? "{}");
    expect(saved.instances).toEqual([B]);
    expect(saved.selectedUrl).toBe(P2.url);
    expect(loadState(storage, [B], pins).selectedUrl).toBe(P2.url);
  });

  it("survive corrupt storage and a deliberately emptied user list", () => {
    const corrupt = memory();
    corrupt.data.set(STORAGE_KEY, "{nope");
    expect(loadState(corrupt, [B], pins).instances).toEqual([pinned(P1), pinned(P2)]);
    const emptied = memory();
    saveState(emptied, { instances: [], selectedUrl: null });
    expect(loadState(emptied, [B], pins).instances).toEqual([pinned(P1), pinned(P2)]);
  });

  it("are parsed from the configuration and ignored when it is missing or invalid", () => {
    expect(configuredInstances(JSON.stringify(pins))).toEqual(pins);
    expect(configuredInstances(undefined)).toEqual([]);
    expect(configuredInstances("{bad json")).toEqual([]);
    expect(configuredInstances("[]")).toEqual([]);
  });
});
