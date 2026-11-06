import { useId, useState } from "react";

/**
 * A "(?)" button with an explanation that opens on hover or keyboard focus and
 * closes on leave, blur or Escape. The text is fixed-positioned under the
 * button so a scrolling table wrapper cannot clip it, and it stays in the DOM
 * so `aria-describedby` always resolves.
 */
export function HelpTip({ label, children }: { label: string; children: React.ReactNode }) {
  const id = useId();
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  function open(button: HTMLElement) {
    const rect = button.getBoundingClientRect();
    const width = Math.min(288, window.innerWidth - 16);
    setPos({ top: rect.bottom + 6, left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)) });
  }

  return (
    <span className="ml-1 inline-block align-middle">
      <button
        type="button"
        aria-label={label}
        aria-describedby={id}
        onMouseEnter={(e) => open(e.currentTarget)}
        onFocus={(e) => open(e.currentTarget)}
        onMouseLeave={() => setPos(null)}
        onBlur={() => setPos(null)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setPos(null);
        }}
        className="grid size-[1.125rem] cursor-help place-items-center rounded-full border border-line text-[0.6875rem] leading-none text-ink-soft hover:text-ink"
      >
        ?
      </button>
      <span
        id={id}
        role="tooltip"
        hidden={pos === null}
        style={pos ? { top: pos.top, left: pos.left } : undefined}
        className="fixed z-20 w-72 max-w-[calc(100vw-1rem)] rounded border border-line bg-raised p-3 text-left text-[0.8125rem] font-normal leading-snug text-ink shadow-lg"
      >
        {children}
      </span>
    </span>
  );
}
