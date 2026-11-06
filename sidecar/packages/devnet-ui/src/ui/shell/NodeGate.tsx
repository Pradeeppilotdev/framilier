import type { ReactNode } from "react";
import { useInfo } from "../../data/hooks";
import type { Instance } from "../../instances/store";
import { checkProtocol } from "../../protocol/compat";
import type { Info } from "../../protocol/schemas";
import { describeError } from "../../rpc/errors";
import { Banner } from "../Banner";
import { QueryErrorBanner } from "../QueryErrorBanner";

/**
 * Shows a screen only when the instance answers and speaks this protocol
 * version; otherwise says what is wrong and what to try.
 */
export function NodeGate({
  instance,
  children,
}: {
  instance: Instance;
  children: (info: Info) => ReactNode;
}) {
  const info = useInfo(instance.url);

  // A blocking gate is only for a node we have no answer from. When a later
  // poll fails but the previous answer is kept, keep the screen (and its
  // filter state) mounted and show the error above it.
  if (info.data === undefined) {
    if (info.isPending) {
      return (
        <p role="status" className="py-10 text-ink-soft">
          Connecting to {instance.name}…
        </p>
      );
    }
    const notice = describeError(info.error, instance.url);
    return (
      <Banner
        tone={notice.kind === "disabled" ? "warn" : "error"}
        title={notice.title}
        hint={notice.hint}
        action={
          <button type="button" onClick={() => void info.refetch()} className="underline underline-offset-4">
            Try again
          </button>
        }
      />
    );
  }
  const compat = checkProtocol(info.data);
  if (!compat.ok) {
    return (
      <Banner
        tone="warn"
        title={`This node speaks explorer protocol v${compat.nodeVersion}`}
        hint={`This app understands v${compat.supported}. Update the app or the node so they match.`}
      />
    );
  }
  return (
    <>
      {info.isError && (
        <div className="mb-4">
          <QueryErrorBanner error={info.error} url={instance.url} onRetry={() => void info.refetch()} />
        </div>
      )}
      {children(info.data)}
    </>
  );
}
