import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TX, primaryNode, secondaryNode } from "../mock/fixtures";
import type { MockNode } from "../mock/state";
import { installMockFetch, renderApp } from "./testUtils";

const A = { name: "Devnet miner", url: "http://mock-a/rpc" };
const B = { name: "Local peer", url: "http://mock-b/rpc" };

beforeEach(() => {
  installMockFetch({ [A.url]: primaryNode(), [B.url]: secondaryNode() });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The header polls the selected instance; a refused node URL must cause no other request. */
function expectNoRequestBeyondSelected(): void {
  const urls = vi.mocked(fetch).mock.calls.map(([input]) => String(input));
  expect(urls.filter((u) => u !== A.url)).toEqual([]);
}

const txPath = (hash: string, node: string) => `/tx/${hash}?node=${encodeURIComponent(node)}`;

describe("malformed or odd node URLs", () => {
  it("offers nothing to add for a node that is not http or https", async () => {
    renderApp({ path: txPath(TX.onChain.hash, "ftp://mock-b/rpc"), instances: [A] });
    expect(await screen.findByText("Not a valid node URL")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add to list" })).toBeNull();
    expectNoRequestBeyondSelected();
  });

  it.each(["garbage", "//other.host/rpc"])("refuses %s as a node without querying it", async (bad) => {
    renderApp({ path: txPath(TX.onChain.hash, bad), instances: [A] });
    expect(await screen.findByText("Not a valid node URL")).toBeTruthy();
    expect(screen.getByText(bad)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Transaction" })).toBeNull();
    expectNoRequestBeyondSelected();
  });

  it("treats an empty ?node= as absent and uses the selected instance", async () => {
    renderApp({ path: `/tx/${TX.onChain.hash}?node=`, instances: [A] });
    expect(await screen.findByText("Every rule passed.")).toBeTruthy();
  });

  it("renders the instance rail with a corrupt stored URL instead of crashing", async () => {
    renderApp({ instances: [{ name: "Broken", url: "not a url" }] });
    expect(await screen.findByRole("button", { name: /^Broken/ })).toBeTruthy();
    expect(screen.getByTitle("not a url")).toBeTruthy();
  });
});

describe("Add to list and the cross-instance comparison", () => {
  it("adds the normalized URL, not the raw node parameter", async () => {
    const user = userEvent.setup();
    renderApp({ path: txPath(TX.onlySecondary.hash, "http://mock-b/rpc/"), instances: [A] });
    await user.click(await screen.findByRole("button", { name: "Add to list" }));
    expect(await screen.findByTitle("http://mock-b/rpc")).toBeTruthy();
    expect(screen.queryByTitle("http://mock-b/rpc/")).toBeNull();
  });

  it("includes an unlisted ?node= instance in the comparison next to the listed ones", async () => {
    renderApp({ path: txPath(TX.onlySecondary.hash, B.url), instances: [A] });
    const across = (await screen.findByRole("heading", { name: "Across instances" })).closest("section")!;
    await waitFor(() => expect(within(across).getByText("Has not seen it")).toBeTruthy());
    expect(within(across).getByText("Devnet miner")).toBeTruthy();
    expect(within(across).getByText("mock-b")).toBeTruthy();
  });

  it("does not duplicate a listed instance that ?node= writes with a trailing slash", async () => {
    renderApp({ path: txPath(TX.onChain.hash, "http://mock-a/rpc/"), instances: [A, B] });
    const across = (await screen.findByRole("heading", { name: "Across instances" })).closest("section")!;
    await waitFor(() => expect(within(across).getAllByRole("row")).toHaveLength(3));
    expect(screen.queryByText(/isn't in your list/)).toBeNull();
  });
});

describe("transaction page gate", () => {
  it("shows the protocol-mismatch gate for the node it asks", async () => {
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
    renderApp({ path: txPath(TX.onChain.hash, A.url), instances: [A] });
    expect(await screen.findByText("This node speaks explorer protocol v2")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Transaction" })).toBeNull();
  });
});

/** Makes a node answer one method with an RPC error from now on. */
function failMethod(node: MockNode, method: string): void {
  const original = node.handle.bind(node);
  node.handle = (m, params) =>
    m === method ? { error: { code: -32000, message: "Backend hiccup" } } : original(m, params);
}

describe("a failing refetch keeps the loaded rows", () => {
  it.each([
    ["Pool", "/", "skandha_explorer_listTransactions", () => screen.findByTitle(TX.onChain.hash)],
    ["Activity", "/activity", "skandha_explorer_listAdmissions", () => screen.findByTitle(TX.onChain.hash)],
    ["Peers", "/peers", "skandha_explorer_peers", () => screen.findByText("skandha/4.1.1")],
  ])("%s shows the error above the rows", async (_name, path, method, loaded) => {
    const node = primaryNode();
    installMockFetch({ [A.url]: node });
    const { queryClient } = renderApp({ path, instances: [A] });
    await loaded();

    failMethod(node, method);
    await act(async () => {
      await queryClient.refetchQueries({ predicate: (q) => q.queryKey.includes("pool") || q.queryKey.includes("activity") || q.queryKey.includes("peers") });
    });

    expect(await screen.findByText("Backend hiccup")).toBeTruthy();
    expect(await loaded()).toBeTruthy();
  });

  it("shows only the error when there was never any data", async () => {
    const node = primaryNode();
    failMethod(node, "skandha_explorer_listTransactions");
    installMockFetch({ [A.url]: node });
    renderApp({ instances: [A] });
    expect(await screen.findByText("Backend hiccup")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText("The pool is empty.")).toBeNull();
  });
});

describe("a failing info poll keeps the screen", () => {
  it("keeps the loaded pool rows and the filter, with an error banner above them", async () => {
    const user = userEvent.setup();
    const node = primaryNode();
    installMockFetch({ [A.url]: node });
    const { queryClient } = renderApp({ instances: [A] });
    await user.selectOptions(await screen.findByLabelText("Status"), "OnChain");
    await screen.findByTitle(TX.onChain.hash);

    failMethod(node, "skandha_explorer_info");
    await act(async () => {
      await queryClient.refetchQueries({ predicate: (q) => q.queryKey.includes("info") });
    });

    expect(await screen.findByText("Backend hiccup")).toBeTruthy();
    expect(screen.getByTitle(TX.onChain.hash)).toBeTruthy();
    expect((screen.getByLabelText("Status") as HTMLSelectElement).value).toBe("OnChain");
  });

  it("still gates a protocol mismatch on the retained info", async () => {
    const node = primaryNode();
    const original = node.handle.bind(node);
    let version = 1;
    node.handle = (method, params) => {
      const outcome = original(method, params);
      if (method === "skandha_explorer_info" && "result" in outcome && version !== 1) {
        return { result: { ...(outcome.result as object), protocolVersion: version } };
      }
      return outcome;
    };
    installMockFetch({ [A.url]: node });
    const { queryClient } = renderApp({ instances: [A] });
    await screen.findByTitle(TX.onChain.hash);
    version = 2;
    await act(async () => {
      await queryClient.refetchQueries({ predicate: (q) => q.queryKey.includes("info") });
    });
    expect(await screen.findByText("This node speaks explorer protocol v2")).toBeTruthy();
  });
});
