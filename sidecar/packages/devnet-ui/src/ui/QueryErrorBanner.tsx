import { describeError } from "../rpc/errors";
import { Banner } from "./Banner";

/**
 * The error of a failed query. Screens show it above any rows they already
 * loaded, so a failed background refresh never hides what was on screen.
 */
export function QueryErrorBanner({ error, url, onRetry }: { error: unknown; url: string; onRetry?: () => void }) {
  const notice = describeError(error, url);
  return (
    <Banner
      tone="error"
      title={notice.title}
      hint={notice.hint}
      action={
        onRetry && (
          <button type="button" onClick={onRetry} className="underline underline-offset-4">
            Try again
          </button>
        )
      }
    />
  );
}
