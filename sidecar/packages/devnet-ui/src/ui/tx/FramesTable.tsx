import clsx from "clsx";
import type { FrameView } from "../../logic/frames";
import { formatBytes, shortAddress } from "../../logic/format";

/** The frames as sent: what each one is, who it calls, and how much gas and value it carries. */
export function FramesTable({ frames }: { frames: FrameView[] }) {
  return (
    <section aria-labelledby="frames-title">
      <h2 id="frames-title" className="mb-3 text-xl">
        Frame details
      </h2>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[44rem] text-left">
          <thead>
            <tr className="border-b border-line text-[0.8125rem] text-ink-soft">
              <th scope="col" className="py-2 pr-4 font-normal">Frame</th>
              <th scope="col" className="py-2 pr-4 font-normal">Role</th>
              <th scope="col" className="py-2 pr-4 font-normal">Approves</th>
              <th scope="col" className="py-2 pr-4 font-normal">Target</th>
              <th scope="col" className="py-2 pr-4 font-normal">Gas limit</th>
              <th scope="col" className="py-2 pr-4 font-normal">State gas</th>
              <th scope="col" className="py-2 pr-4 font-normal">Value</th>
              <th scope="col" className="py-2 pr-4 font-normal">Data</th>
              <th scope="col" className="py-2 font-normal">Status</th>
            </tr>
          </thead>
          <tbody>
            {frames.length === 0 && (
              <tr className="border-b border-line">
                <td colSpan={9} className="py-3 text-ink-soft">
                  No frames in this transaction.
                </td>
              </tr>
            )}
            {frames.map((frame) => (
              <tr key={frame.index} className="border-b border-line align-top">
                <td className="tabular py-2.5 pr-4 font-display font-semibold">{frame.index}</td>
                <td className="py-2.5 pr-4">
                  {frame.role}
                  <span className="block text-[0.8125rem] text-ink-soft">
                    {frame.modeName} mode{frame.atomic ? ", atomic with next" : ""}
                    {frame.entity ? `, ${frame.entity}` : ""}
                  </span>
                </td>
                <td className="py-2.5 pr-4">{frame.scope}</td>
                <td className="py-2.5 pr-4 font-mono text-[0.8125rem]" title={frame.target ?? undefined}>
                  {frame.target ? shortAddress(frame.target) : "the sender"}
                </td>
                <td className="tabular py-2.5 pr-4">{frame.executionGas.toLocaleString("en-US")}</td>
                <td className="tabular py-2.5 pr-4">{frame.stateGas.toLocaleString("en-US")}</td>
                <td className="tabular py-2.5 pr-4">{frame.value.toLocaleString("en-US")} wei</td>
                <td className="tabular py-2.5 pr-4">{frame.dataBytes === 0 ? "none" : formatBytes(frame.dataBytes)}</td>
                <td className={clsx("py-2.5", frame.status === "reverted" && "text-fail")}>
                  {frame.status === "reverted" ? "Reverted" : frame.status === "not-run" ? "Not simulated" : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
