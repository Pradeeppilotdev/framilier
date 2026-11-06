import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FramesTable } from "./FramesTable";
import type { FrameView } from "../../logic/frames";

const frame = (over: Partial<FrameView> = {}): FrameView => ({
  index: 0,
  mode: 1,
  modeName: "verify",
  role: "Validation",
  scope: "payment",
  atomic: false,
  entity: undefined,
  target: null,
  executionGas: 1000n,
  stateGas: 0n,
  value: 0n,
  dataBytes: 0,
  ...over,
});

describe("FramesTable", () => {
  it("writes byte counts with the singular for one byte and none for empty data", () => {
    render(
      <FramesTable
        frames={[frame({ index: 0, dataBytes: 0 }), frame({ index: 1, dataBytes: 1 }), frame({ index: 2, dataBytes: 36 })]}
      />,
    );
    expect(screen.getByText("none")).toBeTruthy();
    expect(screen.getByText("1 byte")).toBeTruthy();
    expect(screen.getByText("36 bytes")).toBeTruthy();
    expect(screen.queryByText("1 bytes")).toBeNull();
  });

  it("says so when the transaction has no frames", () => {
    render(<FramesTable frames={[]} />);
    expect(screen.getByText("No frames in this transaction.")).toBeTruthy();
  });

  it("shows a status cell only for a frame that reverted or never ran", () => {
    render(
      <FramesTable
        frames={[
          frame({ index: 0, status: "success" }),
          frame({ index: 1, status: "reverted" }),
          frame({ index: 2, status: "not-run" }),
          frame({ index: 3, status: undefined }),
        ]}
      />,
    );
    expect(screen.getByText("Reverted")).toBeTruthy();
    expect(screen.getByText("Not simulated")).toBeTruthy();
  });
});
