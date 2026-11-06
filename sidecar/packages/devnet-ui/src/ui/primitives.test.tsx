import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Banner } from "./Banner";
import { CopyText } from "./CopyText";
import { FrameStrip, frameVerdict, framesOfCount } from "./FrameStrip";
import { StatusBadge } from "./StatusBadge";
import { VerdictMark } from "./VerdictMark";
import type { Check } from "../protocol/schemas";

describe("VerdictMark", () => {
  it("names each verdict for assistive technology", () => {
    render(
      <>
        <VerdictMark verdict="pass" />
        <VerdictMark verdict="fail" />
        <VerdictMark verdict="skipped" />
        <VerdictMark verdict="fail" title="Banned opcodes: failed" />
      </>,
    );
    expect(screen.getByRole("img", { name: "Passed" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Failed" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Not evaluated" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Banned opcodes: failed" })).toBeTruthy();
  });
});

describe("StatusBadge", () => {
  it("shows a readable label and passes unknown statuses through", () => {
    render(
      <>
        <StatusBadge status="OnChain" />
        <StatusBadge status="rejected" />
        <StatusBadge status="SomethingNew" />
      </>,
    );
    expect(screen.getByText("On chain")).toBeTruthy();
    expect(screen.getByText("Rejected")).toBeTruthy();
    expect(screen.getByText("SomethingNew")).toBeTruthy();
  });
});

describe("Banner", () => {
  it("is an alert for errors and a status otherwise, with a hint and an action", () => {
    render(
      <>
        <Banner tone="error" title="Couldn't reach node" hint="Check the URL." action={<button>Try again</button>} />
        <Banner tone="info" title="Reloaded" />
      </>,
    );
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("Couldn't reach node")).toBeTruthy();
    expect(within(alert).getByText("Check the URL.")).toBeTruthy();
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Reloaded");
  });
});

describe("CopyText", () => {
  // Tests replace navigator.clipboard; put back whatever was there before.
  const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  afterEach(() => {
    if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
  });

  it("copies the full value and shows that it did, without renaming the button", async () => {
    const user = userEvent.setup();
    // Defined after setup(): user-event installs its own clipboard stub there.
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<CopyText value="0x1234567890abcdef" display="0x1234…cdef" />);
    const button = screen.getByRole("button", { name: "0x1234…cdef" });
    expect(button.getAttribute("title")).toBe("Copy 0x1234567890abcdef");
    await user.click(button);
    expect(writeText).toHaveBeenCalledWith("0x1234567890abcdef");
    const note = await screen.findByText("Copied");
    expect(note.getAttribute("aria-live")).toBe("polite");
    expect(button.contains(note)).toBe(false);
    expect(screen.getByRole("button", { name: "0x1234…cdef" })).toBe(button);
  });

  it("says when copying failed, and never claims a copy", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => {
      throw new Error("denied");
    });
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<CopyText value="0xabc" />);
    await user.click(screen.getByRole("button"));
    expect(await screen.findByText("Copy failed")).toBeTruthy();
    expect(screen.queryByText("Copied")).toBeNull();
  });

  it("clears the message after a few seconds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      Object.defineProperty(navigator, "clipboard", { value: { writeText: async () => {} }, configurable: true });
      render(<CopyText value="0xabc" />);
      await user.click(screen.getByRole("button"));
      expect(await screen.findByText("Copied")).toBeTruthy();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4000);
      });
      expect(screen.queryByText("Copied")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not claim a copy when the clipboard is unavailable", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    render(<CopyText value="0xabc" />);
    await user.click(screen.getByRole("button"));
    expect(await screen.findByText("Copy unavailable")).toBeTruthy();
    expect(screen.queryByText("Copied")).toBeNull();
  });
});

const checks: Check[] = [
  { rule: "trace-alignment", frameIndex: 0, entity: "payer", verdict: "pass" },
  { rule: "OP-011", frameIndex: 0, entity: "payer", verdict: "fail", detail: "x" },
  { rule: "trace-alignment", frameIndex: 1, entity: "sender", verdict: "pass" },
];

describe("frameVerdict", () => {
  it("fails on any failure, is skipped only when everything is, and is undefined with no checks", () => {
    expect(frameVerdict([])).toBeUndefined();
    expect(frameVerdict(checks.slice(0, 2))).toBe("fail");
    expect(frameVerdict([{ rule: "a", verdict: "skipped" }])).toBe("skipped");
    expect(frameVerdict([{ rule: "a", verdict: "pass" }, { rule: "b", verdict: "skipped" }])).toBe("pass");
  });

  it("with no checks, falls back to the simulation run status: reverted fails, success and not-run stay undefined", () => {
    expect(frameVerdict([], "reverted")).toBe("fail");
    expect(frameVerdict([], "success")).toBeUndefined();
    expect(frameVerdict([], "not-run")).toBeUndefined();
  });

  it("checks take priority over run status when both are present", () => {
    expect(frameVerdict([{ rule: "a", verdict: "pass" }], "reverted")).toBe("pass");
  });
});

describe("frame helpers", () => {
  it("numbers a bare strip of frames whose modes are not known", () => {
    expect(framesOfCount(3).map((f) => f.index)).toEqual([0, 1, 2]);
  });
});

describe("FrameStrip", () => {
  const frames = [
    { index: 0, mode: 1, role: "self-verification", entity: "payer" },
    { index: 1, mode: 2, role: "user operation", atomic: true },
  ];

  it("small: labels each frame with its role and verdict", () => {
    render(<FrameStrip frames={frames} checks={checks} />);
    expect(screen.getByLabelText("Frame 0, self-verification: failed")).toBeTruthy();
    expect(screen.getByLabelText("Frame 1, user operation: passed")).toBeTruthy();
  });

  it("small: marks a failure that happened before any frame was examined", () => {
    render(<FrameStrip frames={[]} globalFailure={{ rule: "prefix", verdict: "fail" }} />);
    expect(screen.getByLabelText("Validation prefix: failed")).toBeTruthy();
  });

  it("small: draws frames whose mode is unknown, with no verdict when there are no checks", () => {
    render(<FrameStrip frames={framesOfCount(2)} />);
    expect(screen.getByLabelText("Frame 0")).toBeTruthy();
    expect(screen.getByLabelText("Frame 1")).toBeTruthy();
  });

  it("small: marks a frame the simulation never reached as not simulated, dimmed", () => {
    render(<FrameStrip frames={[{ index: 0, status: "not-run" }]} />);
    const li = screen.getByLabelText("Frame 0 (not simulated)");
    expect(li).toBeTruthy();
    expect(li.className).toMatch(/opacity/);
  });

  it("small: marks a reverted frame with no rule check as reverted, without claiming a rule failed", () => {
    render(<FrameStrip frames={[{ index: 0, status: "reverted" }]} />);
    expect(screen.getByLabelText("Frame 0: reverted")).toBeTruthy();
  });

  it("small: a rule verdict takes priority over run status in the label", () => {
    render(<FrameStrip frames={[{ index: 0, status: "reverted" }]} checks={[{ rule: "OP-011", frameIndex: 0, verdict: "fail" }]} />);
    expect(screen.getByLabelText("Frame 0: failed")).toBeTruthy();
  });

  it("large: shows role, entity, atomic flag and one mark per check", () => {
    render(<FrameStrip frames={frames} checks={checks} size="lg" />);
    expect(screen.getByText("self-verification")).toBeTruthy();
    expect(screen.getByText("payer")).toBeTruthy();
    expect(screen.getByText("atomic with the next frame")).toBeTruthy();
    const marks = screen.getByLabelText("Checks for frame 0");
    expect(within(marks).getByRole("img", { name: "Banned opcodes: failed" })).toBeTruthy();
    expect(within(marks).getByRole("img", { name: "Trace alignment: passed" })).toBeTruthy();
  });

  it("large: shows a before-the-frames block for a transaction-level failure", () => {
    render(<FrameStrip frames={[]} size="lg" globalFailure={{ rule: "prefix", verdict: "fail" }} />);
    expect(screen.getByText("Before the frames")).toBeTruthy();
    expect(screen.getByText("Validation prefix")).toBeTruthy();
  });

  it("large: dims a frame the simulation never reached", () => {
    render(<FrameStrip frames={[{ index: 0, status: "not-run" }]} size="lg" />);
    expect(screen.getByText("Not simulated")).toBeTruthy();
  });

  it("large: captions a reverted frame with no rule check, without claiming a rule failed", () => {
    render(<FrameStrip frames={[{ index: 0, status: "reverted" }]} size="lg" />);
    expect(screen.getByText("Reverted")).toBeTruthy();
  });
});
