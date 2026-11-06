import clsx from "clsx";
import { useLive } from "../../data/live";

/** Whether the selected instance is pushing updates, or the page is polling instead. */
export function LiveChip() {
  const { status, fatal } = useLive();
  let text: string;
  let dot: string;
  if (fatal) {
    text = "Polling, live updates unavailable";
    dot = "bg-warn";
  } else if (status === "live") {
    text = "Live";
    dot = "bg-pass";
  } else if (status === "offline") {
    text = "Offline, retrying";
    dot = "bg-fail";
  } else if (status === "reconnecting") {
    text = "Reconnecting";
    dot = "bg-warn";
  } else {
    text = "Connecting";
    dot = "border border-ink-soft";
  }
  return (
    <p role="status" className="inline-flex items-center gap-2 text-[0.8125rem] text-ink-soft">
      <span aria-hidden className={clsx("size-2 rounded-full", dot)} />
      {text}
    </p>
  );
}
