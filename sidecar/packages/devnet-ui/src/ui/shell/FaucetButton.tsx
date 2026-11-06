import { useEffect, useRef, useState, type FormEvent } from "react";
import { explorerApi } from "../../rpc/methods";
import { describeError } from "../../rpc/errors";
import { Banner } from "../Banner";
import { CopyText } from "../CopyText";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** "Faucet" opens a pop-up that asks the node to send 1 ETH to an address. */
export function FaucetButton({ url }: { url: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="border border-line bg-raised px-3 py-1 hover:border-ink"
      >
        Faucet
      </button>
      {open && <FaucetDialog url={url} onClose={() => setOpen(false)} />}
    </>
  );
}

function FaucetDialog({ url, onClose }: { url: string; onClose: () => void }) {
  const [address, setAddress] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ title: string; hint?: string } | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = address.trim();
    if (!ADDRESS.test(value)) {
      setError({ title: "Enter an address: 0x followed by 40 hex characters." });
      return;
    }
    setError(null);
    setPending(true);
    try {
      const result = await explorerApi.faucet(url, value);
      setSent(result.txHash);
    } catch (err) {
      const notice = describeError(err, url);
      setError({ title: notice.title, hint: notice.hint });
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-20 grid place-items-center bg-black/40 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="faucet-title"
        className="w-full max-w-[30rem] border border-line bg-paper p-6"
      >
        <h2 id="faucet-title" className="text-[1.25rem] font-semibold">
          Faucet
        </h2>
        {sent ? (
          <div className="mt-3 space-y-3">
            <Banner tone="info" title="Sent 1 ETH" hint="It arrives when the next block is mined." />
            <p className="flex items-center gap-2">
              <span className="text-ink-soft">Transaction</span>
              <CopyText value={sent} />
            </p>
          </div>
        ) : (
          <form onSubmit={submit} className="mt-3 space-y-3">
            <p className="text-ink-soft">Sends 1 ETH to an address. Each address can ask once an hour.</p>
            <label className="block">
              <span className="sr-only">Address</span>
              <input
                ref={input}
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="0x…"
                spellCheck={false}
                autoComplete="off"
                className="w-full border border-line bg-raised px-2 py-1.5 font-mono text-[0.8125rem]"
              />
            </label>
            {error && <Banner tone="error" title={error.title} hint={error.hint} />}
            <div className="flex items-center gap-4">
              <button
                type="submit"
                disabled={pending}
                className="border border-ink bg-ink px-3 py-1 text-paper disabled:opacity-60"
              >
                {pending ? "Sending…" : "Send 1 ETH"}
              </button>
            </div>
          </form>
        )}
        <button type="button" onClick={onClose} className="mt-4 text-ink-soft underline underline-offset-4">
          Close
        </button>
      </div>
    </div>
  );
}
