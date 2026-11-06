import { useState, type FormEvent } from "react";
import clsx from "clsx";
import { useInfo } from "../../data/hooks";
import { useInstances } from "../../instances/context";
import { validateNewInstance, type Instance } from "../../instances/store";
import { checkProtocol } from "../../protocol/compat";
import { describeError, hostOf } from "../../rpc/errors";

type Lamp = "up" | "warn" | "down" | "checking";

const LAMP_DOT: Record<Lamp, string> = {
  up: "bg-pass",
  warn: "bg-warn",
  down: "bg-fail",
  checking: "border border-ink-soft",
};

/** Reads one instance's health from its polled `info`. */
function useHealth(url: string): { lamp: Lamp; text: string } {
  const info = useInfo(url);
  if (info.isPending) return { lamp: "checking", text: "Checking" };
  if (info.isError) {
    const notice = describeError(info.error, url);
    if (notice.kind === "unreachable") return { lamp: "down", text: "Unreachable" };
    if (notice.kind === "disabled") return { lamp: "warn", text: "Explorer off" };
    return { lamp: "warn", text: "Unexpected answer" };
  }
  const compat = checkProtocol(info.data);
  if (!compat.ok) return { lamp: "warn", text: `Protocol v${compat.nodeVersion}` };
  return { lamp: "up", text: `Up, chain ${info.data.chainId}` };
}

function InstanceRow({ instance, selected }: { instance: Instance; selected: boolean }) {
  const { dispatch } = useInstances();
  const health = useHealth(instance.url);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(instance.name);

  function saveName(event: FormEvent) {
    event.preventDefault();
    dispatch({ type: "rename", url: instance.url, name: draft });
    setRenaming(false);
  }

  return (
    <li className={clsx("group border-b border-line", selected && "bg-paper shadow-[inset_3px_0_0_var(--accent)]")}>
      {renaming ? (
        <form onSubmit={saveName} className="flex items-center gap-2 px-4 py-3">
          <label className="sr-only" htmlFor={`rename-${instance.url}`}>
            Name for {instance.url}
          </label>
          <input
            id={`rename-${instance.url}`}
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="min-w-0 flex-1 border border-line bg-raised px-2 py-1"
          />
          <button type="submit" className="underline underline-offset-4">
            Save
          </button>
          <button type="button" onClick={() => setRenaming(false)} className="text-ink-soft underline underline-offset-4">
            Cancel
          </button>
        </form>
      ) : (
        <div className="px-4 py-3">
          <button
            type="button"
            onClick={() => dispatch({ type: "select", url: instance.url })}
            aria-current={selected ? "true" : undefined}
            className="block w-full text-left"
          >
            <span className="flex items-center gap-2">
              <span aria-hidden className={clsx("size-2.5 shrink-0 rounded-full", LAMP_DOT[health.lamp])} />
              <span className="font-display text-[1.0625rem] font-semibold">{instance.name}</span>
              {instance.pinned && (
                <span
                  className="ml-auto text-[0.75rem] text-ink-soft"
                  title="Set by this site's configuration, so it can't be renamed or removed."
                >
                  Pinned
                </span>
              )}
            </span>
            <span className="mt-0.5 block truncate pl-[1.125rem] text-[0.8125rem] text-ink-soft">
              {health.text}
            </span>
            <span className="block truncate pl-[1.125rem] font-mono text-[0.75rem] text-ink-soft" title={instance.url}>
              {hostOf(instance.url)}
            </span>
          </button>
          {!instance.pinned && (
          <div
            className={clsx(
              "mt-1 flex gap-4 pl-[1.125rem] text-[0.8125rem] transition-opacity",
              !selected && "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100",
            )}
          >
            <button
              type="button"
              onClick={() => {
                setDraft(instance.name);
                setRenaming(true);
              }}
              className="text-ink-soft underline underline-offset-4"
              aria-label={`Rename ${instance.name}`}
            >
              Rename
            </button>
            <button
              type="button"
              onClick={() => dispatch({ type: "remove", url: instance.url })}
              className="text-ink-soft underline underline-offset-4"
              aria-label={`Remove ${instance.name}`}
            >
              Remove
            </button>
          </div>
          )}
        </div>
      )}
    </li>
  );
}

function AddInstance() {
  const { instances, dispatch } = useInstances();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit(event: FormEvent) {
    event.preventDefault();
    const checked = validateNewInstance({ instances, selectedUrl: null }, name, url);
    if (!checked.ok) {
      setError(checked.error);
      return;
    }
    dispatch({ type: "add", instance: checked.instance });
    dispatch({ type: "select", url: checked.instance.url });
    setName("");
    setUrl("");
    setError(null);
    setOpen(false);
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="w-full px-4 py-3 text-left underline underline-offset-4">
        Add instance
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 px-4 py-3" aria-label="Add an instance">
      <label className="flex flex-col gap-1 text-[0.8125rem] text-ink-soft">
        Node URL
        <input
          autoFocus
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://altmempool.forshtat.com"
          className="border border-line bg-raised px-2 py-1.5 font-mono text-[0.8125rem] text-ink"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "add-instance-error" : undefined}
        />
      </label>
      <label className="flex flex-col gap-1 text-[0.8125rem] text-ink-soft">
        Name (optional)
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="border border-line bg-raised px-2 py-1.5 text-ink"
        />
      </label>
      {error && (
        <p id="add-instance-error" role="alert" className="text-[0.8125rem] text-fail">
          {error}
        </p>
      )}
      <div className="flex gap-4">
        <button type="submit" className="underline underline-offset-4">
          Add
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          className="text-ink-soft underline underline-offset-4"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

export const HOME_URL = "https://www.altmempool.wtf/";

/** The shared list of instances: pick one to inspect, rename or remove it, or add another. */
export function InstanceRail() {
  const { instances, selected } = useInstances();
  return (
    <nav aria-label="Instances" className="bg-rail">
      <div className="px-4 pt-5">
        <a
          href={HOME_URL}
          className="block border-2 border-accent bg-accent-wash px-4 py-3 text-center text-[1.25rem] font-semibold text-ink no-underline hover:bg-accent hover:text-paper"
        >
          Home
        </a>
      </div>
      <h2 className="px-4 pt-5 pb-3 text-[1.125rem]">Instances</h2>
      {instances.length === 0 ? (
        <p className="px-4 pb-3 text-ink-soft">No instances yet. Add the URL of a sidecar node to start.</p>
      ) : (
        <ul className="m-0 list-none border-t border-line p-0">
          {instances.map((instance) => (
            <InstanceRow key={instance.url} instance={instance} selected={instance.url === selected?.url} />
          ))}
        </ul>
      )}
      <AddInstance />
    </nav>
  );
}
