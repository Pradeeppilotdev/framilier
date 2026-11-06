import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TX, disabledNode, primaryNode, secondaryNode } from "../mock/fixtures";
import type { StreamCallbacks } from "./rpc/stream";
import type { StreamFactory } from "./data/live";
import { shortHash } from "./logic/format";
import { installMockFetch, renderApp } from "./testUtils";

const A = { name: "Devnet miner", url: "http://mock-a/rpc" };
const B = { name: "Local peer", url: "http://mock-b/rpc" };
const OFF = { name: "No explorer", url: "http://mock-off/rpc" };
const DOWN = { name: "Unplugged", url: "http://mock-down/rpc" };

beforeEach(() => {
  installMockFetch({
    [A.url]: primaryNode(),
    [B.url]: secondaryNode(),
    [OFF.url]: disabledNode(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("home link", () => {
  it("sits above the instance list and leads to the project home page", async () => {
    renderApp({ instances: [A] });
    const home = await screen.findByRole("link", { name: "Home" });
    expect(home.getAttribute("href")).toBe("https://www.altmempool.wtf/");
    const rail = screen.getByRole("navigation", { name: "Instances" });
    expect(rail.contains(home)).toBe(true);
    expect(home.compareDocumentPosition(within(rail).getByRole("heading", { name: "Instances" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("pool screen", () => {
  it("shows the selected instance's facts and only what is in its mempool", async () => {
    renderApp({ instances: [A, B] });
    expect(await screen.findByText("Chain 1337, auto bundling, Sidecar 4.1.1 (a1b2c3d), p2p on")).toBeTruthy();
    expect(await screen.findByTitle(TX.onChain.hash)).toBeTruthy();
    expect(screen.getByTitle(TX.sponsored.hash)).toBeTruthy();
    expect(screen.getByTitle(TX.replacedNew.hash)).toBeTruthy();
    expect(screen.queryByTitle(TX.bannedOpcode.hash)).toBeNull(); // rejected: never pooled
    expect(screen.queryByTitle(TX.replacedOld.hash)).toBeNull(); // replaced: left the pool
    const table = within(screen.getByRole("table"));
    expect(table.getByText("On chain")).toBeTruthy();
    expect(table.getByText("Reverted")).toBeTruthy();
  });

  it("shows how each transaction reached the node: by RPC, or over p2p and from which peer", async () => {
    renderApp({ instances: [A] });
    const onChainRow = (await screen.findByTitle(TX.onChain.hash)).closest("tr")!;
    expect(within(onChainRow).getByText("Submitted by RPC")).toBeTruthy();
    const sponsoredRow = screen.getByTitle(TX.sponsored.hash).closest("tr")!;
    const p2p = within(sponsoredRow).getByText("P2P from 16Uiu2…EoL4");
    expect(p2p.getAttribute("title")).toBe("16Uiu2HAmKZdV7rQx1uN3YqYc9bTn6k5Zc1fJb2uWq8PzGdXrEoL4");
    expect(screen.getByRole("button", { name: /what does source mean/i })).toBeTruthy();
  });

  it("shows a dash when the node has no record of where a pooled transaction came from", async () => {
    const restarted = primaryNode();
    restarted.restart(); // the pool survives a restart; the in-memory admission history does not
    installMockFetch({ [A.url]: restarted });
    renderApp({ instances: [A] });
    const row = (await screen.findByTitle(TX.onChain.hash)).closest("tr")!;
    expect(within(row).queryByText("Submitted by RPC")).toBeNull();
    expect(within(row).getByTitle(/no record of how/i)).toBeTruthy();
  });

  it("filters by status", async () => {
    const user = userEvent.setup();
    renderApp({ instances: [A] });
    await screen.findByTitle(TX.onChain.hash);
    await user.selectOptions(screen.getByLabelText("Status"), "OnChain");
    await waitFor(() => expect(screen.queryByTitle(TX.sponsored.hash)).toBeNull());
    expect(screen.getByTitle(TX.onChain.hash)).toBeTruthy();
  });

  it("explains an empty pool", async () => {
    installMockFetch({ [A.url]: secondaryNode(), [B.url]: secondaryNode() });
    const user = userEvent.setup();
    renderApp({ instances: [A] });
    await screen.findByTitle(TX.onlySecondary.hash);
    await user.selectOptions(screen.getByLabelText("Status"), "Cancelled");
    expect(await screen.findByText("No Cancelled transactions.")).toBeTruthy();
  });
});

describe("activity screen", () => {
  it("shows what was turned away and why, on the frame strip and in words", async () => {
    renderApp({ path: "/activity", instances: [A] });
    // The reason itself, not just the rule's name: the same detail text the
    // transaction page shows under the failing check.
    expect(await screen.findByText("payer uses banned opcode: DIFFICULTY")).toBeTruthy();
    expect(screen.getByText("frame transaction validation prefix not recognized")).toBeTruthy();
    expect(screen.getByText("Replaced by a newer transaction")).toBeTruthy();
    expect(screen.getAllByLabelText(/^Frame 0.*: failed$/).length).toBeGreaterThan(0);
    expect(screen.getByLabelText("Validation prefix: failed")).toBeTruthy();
  });

  it("filters to rejected transactions", async () => {
    const user = userEvent.setup();
    renderApp({ path: "/activity", instances: [A] });
    await screen.findByText("payer uses banned opcode: DIFFICULTY");
    await user.selectOptions(screen.getByLabelText("Outcome"), "rejected");
    await waitFor(() => expect(screen.queryByTitle(TX.onChain.hash)).toBeNull());
    expect(screen.getByTitle(TX.bannedOpcode.hash)).toBeTruthy();
    expect(screen.getByTitle(TX.noPrefix.hash)).toBeTruthy();
  });
});

describe("transaction screen", () => {
  it("explains a rejection rule by rule, with several violations at once", async () => {
    renderApp({ path: `/tx/${TX.bannedOpcode.hash}?node=${encodeURIComponent(A.url)}`, instances: [A] });
    expect(await screen.findByText("Turned away: Banned opcodes (payer, frame 0).")).toBeTruthy();
    const report = screen.getByRole("heading", { name: "Admission report" }).closest("section")!;
    expect(within(report).getByText("payer uses banned opcode: DIFFICULTY")).toBeTruthy();
    expect(within(report).getByText(/unstaked payer accessed/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Frame 0, payer" })).toBeTruthy();
    const timeline = screen.getByRole("heading", { name: "Timeline" }).closest("section")!;
    expect(within(timeline).getByText("Rejected")).toBeTruthy();
  });

  it("shows a failure before any frame was examined, and the rules that never ran", async () => {
    renderApp({ path: `/tx/${TX.noPrefix.hash}?node=${encodeURIComponent(A.url)}`, instances: [A] });
    expect(await screen.findByText("Turned away: Validation prefix.")).toBeTruthy();
    expect(screen.getByText("Before the frames")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Frame rules not evaluated" })).toBeTruthy();
    const report = screen.getByRole("heading", { name: "Admission report" }).closest("section")!;
    expect(within(report).getByText("frame transaction validation prefix not recognized")).toBeTruthy();
  });

  it("shows an accepted, included transaction with its frames, report and timeline", async () => {
    renderApp({ path: `/tx/${TX.onChain.hash}?node=${encodeURIComponent(A.url)}`, instances: [A] });
    expect(await screen.findByText("Every rule passed.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Frame details" })).toBeTruthy();
    expect(screen.getAllByText("self-verification").length).toBeGreaterThan(0);
    const timeline = screen.getByRole("heading", { name: "Timeline" }).closest("section")!;
    expect(within(timeline).getByText("Included in a block")).toBeTruthy();
  });

  it("shows a whitelist waiver as a pass with its note", async () => {
    renderApp({ path: `/tx/${TX.waived.hash}?node=${encodeURIComponent(A.url)}`, instances: [A] });
    expect(await screen.findByText(/waived \(whitelisted entity\)/)).toBeTruthy();
  });

  it("shows a revert reason", async () => {
    renderApp({ path: `/tx/${TX.reverted.hash}?node=${encodeURIComponent(A.url)}`, instances: [A] });
    const facts = (await screen.findByText("Revert reason")).closest("dl")!;
    expect(within(facts).getByText("execution reverted: insufficient allowance")).toBeTruthy();
  });

  it("still shows a replaced transaction's real frames, from its admission report", async () => {
    renderApp({ path: `/tx/${TX.replacedOld.hash}?node=${encodeURIComponent(A.url)}`, instances: [A] });
    expect(await screen.findByText(/these frames are from the admission report kept for it/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Frame details" })).toBeTruthy();
    const timeline = screen.getByRole("heading", { name: "Timeline" }).closest("section")!;
    expect(within(timeline).getByText("Replaced")).toBeTruthy();
    expect(within(timeline).getByText(`replaced by ${TX.replacedNew.hash}`)).toBeTruthy();
  });

  it("says why a transaction was dropped, instead of calling it a revert", async () => {
    const node = primaryNode();
    node.setStatus(TX.fresh.hash, "Cancelled", "Attempted to relay the transaction multiple times, but failed...");
    installMockFetch({ [A.url]: node });
    renderApp({ path: `/tx/${TX.fresh.hash}?node=${encodeURIComponent(A.url)}`, instances: [A] });
    const term = await screen.findByText("Why it was dropped");
    expect(term.nextElementSibling?.textContent).toBe("Attempted to relay the transaction multiple times, but failed...");
    expect(screen.queryByText("Revert reason")).toBeNull();
  });

  it("names the source: submitted by RPC, or the peer that relayed it over p2p", async () => {
    renderApp({ path: `/tx/${TX.onChain.hash}?node=${encodeURIComponent(A.url)}`, instances: [A] });
    const rpcFact = (await screen.findByText("Source")).nextElementSibling!;
    expect(rpcFact.textContent).toBe("Submitted to this node by RPC");
  });

  it("names the relaying peer for a transaction that came over p2p, and lets you copy its id", async () => {
    renderApp({ path: `/tx/${TX.sponsored.hash}?node=${encodeURIComponent(A.url)}`, instances: [A] });
    const fact = (await screen.findByText("Source")).nextElementSibling!;
    expect(fact.textContent).toMatch(/^P2P, relayed by 16Uiu2…EoL4/);
    expect(within(fact as HTMLElement).getByTitle("Copy 16Uiu2HAmKZdV7rQx1uN3YqYc9bTn6k5Zc1fJb2uWq8PzGdXrEoL4")).toBeTruthy();
  });

  it("says so when the node has never seen the transaction", async () => {
    renderApp({ path: `/tx/0x${"1".repeat(64)}?node=${encodeURIComponent(A.url)}`, instances: [A] });
    expect(await screen.findByText("Devnet miner hasn't seen this transaction.")).toBeTruthy();
  });

  it("lines up which instances saw the transaction and how much later", async () => {
    renderApp({ path: `/tx/${TX.onChain.hash}?node=${encodeURIComponent(A.url)}`, instances: [A, B] });
    const across = (await screen.findByRole("heading", { name: "Across instances" })).closest("section")!;
    await waitFor(() => expect(within(across).getByText("+240 ms")).toBeTruthy());
    expect(within(across).getByText("first")).toBeTruthy();
    expect(within(across).getByText("Submitted by RPC")).toBeTruthy();
    expect(within(across).getByText(/^P2P from /)).toBeTruthy();
  });

  it("marks an instance that has not seen it, or cannot be reached", async () => {
    renderApp({ path: `/tx/${TX.sponsored.hash}?node=${encodeURIComponent(A.url)}`, instances: [A, B, DOWN, OFF] });
    const across = (await screen.findByRole("heading", { name: "Across instances" })).closest("section")!;
    await waitFor(() => expect(within(across).getByText("Has not seen it")).toBeTruthy());
    expect(within(across).getByText("Couldn't reach mock-down")).toBeTruthy();
    expect(within(across).getByText("The explorer isn't available on this node")).toBeTruthy();
  });

  it("offers to add an instance that a shared link points at", async () => {
    const user = userEvent.setup();
    renderApp({ path: `/tx/${TX.onlySecondary.hash}?node=${encodeURIComponent(B.url)}`, instances: [A] });
    expect(await screen.findByText("mock-b isn't in your list")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Add to list" }));
    await waitFor(() => expect(screen.queryByText("mock-b isn't in your list")).toBeNull());
  });
});

describe("node gate", () => {
  it("says the explorer is off, with the flag to use", async () => {
    renderApp({ instances: [OFF] });
    expect(await screen.findByText("The explorer isn't available on this node")).toBeTruthy();
    expect(screen.getByText(/--explorer\.enable/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("says a host cannot be reached, and mentions CORS", async () => {
    renderApp({ instances: [DOWN] });
    expect(await screen.findByText("Couldn't reach mock-down")).toBeTruthy();
    expect(screen.getByText(/--api\.cors/)).toBeTruthy();
  });

  it("warns when the node speaks another protocol version", async () => {
    const node = primaryNode();
    const original = node.handle.bind(node);
    node.handle = (method, params) => {
      const outcome = original(method, params);
      if (method === "skandha_explorer_info" && "result" in outcome) {
        return { result: { ...(outcome.result as object), protocolVersion: 2 } };
      }
      return outcome;
    };
    installMockFetch({ [A.url]: node });
    renderApp({ instances: [A] });
    expect(await screen.findByText("This node speaks explorer protocol v2")).toBeTruthy();
  });
});

describe("instance list", () => {
  it("adds an instance after checking the URL, and selects it", async () => {
    const user = userEvent.setup();
    renderApp({ instances: [A] });
    await screen.findByTitle(TX.onChain.hash);
    await user.click(screen.getByRole("button", { name: "Add instance" }));
    await user.type(screen.getByLabelText("Node URL"), "not a url");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect((await screen.findByRole("alert")).textContent).toContain("URL");

    await user.clear(screen.getByLabelText("Node URL"));
    await user.type(screen.getByLabelText("Node URL"), "http://mock-b");
    await user.type(screen.getByLabelText("Name (optional)"), "Peer");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByRole("heading", { name: "Peer" }, { timeout: 3000 })).toBeTruthy();
  });

  it("refuses a duplicate", async () => {
    const user = userEvent.setup();
    renderApp({ instances: [A] });
    await user.click(await screen.findByRole("button", { name: "Add instance" }));
    await user.type(screen.getByLabelText("Node URL"), "http://mock-a/rpc/");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect((await screen.findByRole("alert")).textContent).toBe("That instance is already in the list.");
  });

  it("renames and removes an instance, and switches the main view to the one you pick", async () => {
    const user = userEvent.setup();
    renderApp({ instances: [A, B] });
    await screen.findByTitle(TX.onChain.hash);

    await user.click(screen.getByRole("button", { name: "Rename Local peer" }));
    const box = screen.getByLabelText("Name for http://mock-b/rpc");
    await user.clear(box);
    await user.type(box, "Laptop");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("button", { name: /^Laptop/ })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /^Laptop/ }));
    expect(await screen.findByRole("heading", { name: "Laptop", level: 1 })).toBeTruthy();
    expect(await screen.findByTitle(TX.onlySecondary.hash)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Remove Laptop" }));
    expect(await screen.findByRole("heading", { name: "Devnet miner", level: 1 })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Laptop/ })).toBeNull();
  });

  it("marks pinned instances and offers no way to rename or remove them", async () => {
    renderApp({ instances: [{ ...A, pinned: true }, B] });
    expect(await screen.findByRole("button", { name: /^Devnet miner/ })).toBeTruthy();
    expect(screen.getByText("Pinned")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove Devnet miner" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Rename Devnet miner" })).toBeNull();
    expect(screen.getByRole("button", { name: "Remove Local peer" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Rename Local peer" })).toBeTruthy();
  });

  it("shows each instance's health", async () => {
    renderApp({ instances: [A, DOWN, OFF] });
    expect(await screen.findByText("Up, chain 1337")).toBeTruthy();
    expect(await screen.findByText("Unreachable")).toBeTruthy();
    expect(await screen.findByText("Explorer off")).toBeTruthy();
  });

  it("invites you to add one when the list is empty", async () => {
    renderApp({ instances: [] });
    expect(await screen.findByText("No instance selected")).toBeTruthy();
    expect(screen.getByText(/No instances yet/)).toBeTruthy();
  });
});

describe("search", () => {
  it("rejects something that is not a transaction hash", async () => {
    const user = userEvent.setup();
    renderApp({ instances: [A] });
    await user.type(await screen.findByLabelText("Find a transaction by hash"), "0x1234{Enter}");
    expect((await screen.findByRole("alert")).textContent).toContain("64 hex characters");
  });

  it("opens the transaction, on the selected instance", async () => {
    const user = userEvent.setup();
    const { router } = renderApp({ instances: [A] });
    await user.type(await screen.findByLabelText("Find a transaction by hash"), `${TX.onChain.hash.toUpperCase().replace("0X", "0x")}{Enter}`);
    expect(await screen.findByText("Every rule passed.")).toBeTruthy();
    expect(router.state.location.pathname).toBe(`/tx/${TX.onChain.hash}`);
    expect(router.state.location.search).toEqual({ node: A.url });
  });
});

describe("peers screen", () => {
  it("lists peers", async () => {
    renderApp({ path: "/peers", instances: [A] });
    expect(await screen.findByText("skandha/4.1.1")).toBeTruthy();
    expect(screen.getByText("outbound")).toBeTruthy();
    expect(screen.getByText(shortHash("16Uiu2HAmKZdV7rQx1uN3YqYc9bTn6k5Zc1fJb2uWq8PzGdXrEoL4", 8, 6))).toBeTruthy();
  });

  it("explains the direction column in a tooltip that opens on focus and closes on Escape", async () => {
    const user = userEvent.setup();
    renderApp({ path: "/peers", instances: [A] });
    await screen.findByText("skandha/4.1.1");
    const help = screen.getByRole("button", { name: /what does direction mean/i });
    const tip = screen.getByRole("tooltip", { hidden: true });
    expect(help.getAttribute("aria-describedby")).toBe(tip.id);
    expect(tip.hidden || tip.className.includes("hidden")).toBe(true);

    await user.tab();
    while (document.activeElement !== help) await user.tab();
    const open = screen.getByRole("tooltip");
    expect(open.textContent).toMatch(/who opened the connection/i);
    expect(open.textContent).toMatch(/inbound/i);
    expect(open.textContent).toMatch(/outbound/i);
    expect(open.textContent).toMatch(/both directions/i);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("explains a node without p2p", async () => {
    renderApp({ path: "/peers", instances: [B] });
    expect(await screen.findByText("This node runs without p2p.")).toBeTruthy();
  });
});

describe("reputation screen", () => {
  it("shows seeded reputation entries with status badges", async () => {
    renderApp({ path: "/reputation", instances: [A] });
    expect(await screen.findByText("OK")).toBeTruthy();
    expect(screen.getByText("Throttled")).toBeTruthy();
    expect(screen.getByText("Banned")).toBeTruthy();
  });

  it("has a nav link to the reputation tab", async () => {
    renderApp({ instances: [A] });
    const link = await screen.findByRole("link", { name: "Reputation" });
    expect(link).toBeTruthy();
  });
});

describe("live status and notices", () => {
  function capturingStream() {
    const callbacks: StreamCallbacks[] = [];
    const factory: StreamFactory = (_instance, cb) => {
      callbacks.push(cb);
      return { start() {}, stop() {} };
    };
    return { callbacks, factory };
  }

  it("shows whether updates are live, and explains a restart until dismissed", async () => {
    const user = userEvent.setup();
    const { callbacks, factory } = capturingStream();
    renderApp({ instances: [A], createStream: factory });
    await screen.findByTitle(TX.onChain.hash);
    expect(screen.getByText("Connecting")).toBeTruthy();

    act(() => callbacks[0]?.onStatus("live"));
    expect(await screen.findByText("Live")).toBeTruthy();

    act(() => callbacks[0]?.onReset("restart"));
    expect(await screen.findByText("This node restarted, so its history was reloaded.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("This node restarted, so its history was reloaded.")).toBeNull();
  });

  it("says live updates are unavailable when the stream can never work, and keeps polling", async () => {
    const { callbacks, factory } = capturingStream();
    renderApp({ instances: [A], createStream: factory });
    await screen.findByTitle(TX.onChain.hash);
    act(() => callbacks[0]?.onFatal("Explorer is disabled: start the node with --explorer.enable"));
    expect(await screen.findByText("Live updates are unavailable on this node")).toBeTruthy();
    expect(screen.getByText("Polling, live updates unavailable")).toBeTruthy();
  });

  it("highlights a row that just changed", async () => {
    const { callbacks, factory } = capturingStream();
    const { container } = renderApp({ instances: [A], createStream: factory });
    await screen.findByTitle(TX.onChain.hash);
    act(() =>
      callbacks[0]?.onEvent({ seq: 999, txHash: TX.onChain.hash, at: Date.now(), kind: "statusChanged" }),
    );
    await waitFor(() => expect(container.querySelector(".row-fresh")).not.toBeNull());
  });
});
