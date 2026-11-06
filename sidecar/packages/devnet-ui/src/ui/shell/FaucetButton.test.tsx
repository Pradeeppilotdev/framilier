import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockNode } from "../../../mock/state";
import { installMockFetch, renderApp } from "../../testUtils";

const A = { name: "Devnet miner", url: "http://mock-a/rpc" };
const ADDRESS = "0x5544596212F91984C986A919C8026DF0576816f9";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("faucet", () => {
  it("is not offered by a node without a faucet", async () => {
    installMockFetch({ [A.url]: new MockNode({ name: "No faucet" }) });
    renderApp({ instances: [A] });
    await screen.findByText(/Chain 1337/);
    expect(screen.queryByRole("button", { name: "Faucet" })).toBeNull();
  });

  it("asks for an address, sends, and reports a node refusal", async () => {
    installMockFetch({ [A.url]: new MockNode({ name: "Faucet", faucet: true }) });
    renderApp({ instances: [A] });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Faucet" }));

    await user.type(screen.getByRole("textbox", { name: "Address" }), "0x123");
    await user.click(screen.getByRole("button", { name: "Send 1 ETH" }));
    expect(screen.getByText(/0x followed by 40 hex/)).toBeTruthy();

    await user.clear(screen.getByRole("textbox", { name: "Address" }));
    await user.type(screen.getByRole("textbox", { name: "Address" }), ADDRESS);
    await user.click(screen.getByRole("button", { name: "Send 1 ETH" }));
    expect(await screen.findByText("Sent 1 ETH")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(screen.getByRole("button", { name: "Faucet" }));
    await user.type(screen.getByRole("textbox", { name: "Address" }), ADDRESS);
    await user.click(screen.getByRole("button", { name: "Send 1 ETH" }));
    expect(await screen.findByText(/already received funds/)).toBeTruthy();
  });
});
