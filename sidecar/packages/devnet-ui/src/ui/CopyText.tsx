import { useEffect, useRef, useState } from "react";
import clsx from "clsx";

/** How long "Copied" (or the failure message) stays visible. */
const NOTE_MS = 2500;

/** Monospaced text that copies its full value when pressed. */
export function CopyText({
  value,
  display,
  className,
}: {
  value: string;
  /** What to show; defaults to the full value. */
  display?: string;
  className?: string;
}) {
  const [note, setNote] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  function show(message: string) {
    setNote(message);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setNote(""), NOTE_MS);
  }

  async function copy() {
    // No clipboard (an insecure origin such as plain http on a LAN address): say so rather than claim a copy.
    if (!navigator.clipboard) {
      show("Copy unavailable");
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      show("Copied");
    } catch {
      show("Copy failed");
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={copy}
        title={`Copy ${value}`}
        className={clsx(
          "cursor-copy text-left font-mono text-[0.8125rem] decoration-dotted underline-offset-4 hover:underline",
          className,
        )}
      >
        {display ?? value}
      </button>
      {/* A sibling of the button, so the announcement does not become part of its name. */}
      <span aria-live="polite" className="ml-2 text-[0.8125rem] text-ink-soft">
        {note}
      </span>
    </>
  );
}
