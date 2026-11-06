import { useState, type FormEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useInstances } from "../../instances/context";

const HASH = /^0x[0-9a-fA-F]{64}$/;

/** Jump to a transaction by hash, on the selected instance. */
export function SearchBox() {
  const navigate = useNavigate();
  const { selected } = useInstances();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit(event: FormEvent) {
    event.preventDefault();
    const hash = value.trim();
    if (!HASH.test(hash)) {
      setError("Enter a transaction hash: 0x followed by 64 hex characters.");
      return;
    }
    setError(null);
    setValue("");
    void navigate({
      to: "/tx/$hash",
      params: { hash: hash.toLowerCase() },
      search: { node: selected?.url },
    });
  }

  return (
    <form onSubmit={submit} role="search" className="w-full sm:w-[24rem]">
      <label className="sr-only" htmlFor="tx-search">
        Find a transaction by hash
      </label>
      <input
        id="tx-search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Find a transaction by hash"
        spellCheck={false}
        autoComplete="off"
        className="w-full border border-line bg-raised px-3 py-1.5 font-mono text-[0.8125rem]"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? "tx-search-error" : undefined}
      />
      {error && (
        <p id="tx-search-error" role="alert" className="mt-1 text-[0.8125rem] text-fail">
          {error}
        </p>
      )}
    </form>
  );
}
