import clsx from "clsx";

export type GaugeZone = "ok" | "throttled" | "banned";

export interface GaugeInput {
  opsSeen: number;
  opsIncluded: number;
  minInclusionDenominator: number;
  throttlingSlack: number;
  banSlack: number;
}

export interface GaugePosition {
  /** How far behind inclusion this entity is, relative to what ReputationEntry.isBanned/isThrottled expect. */
  deficit: number;
  zone: GaugeZone;
  /** 0-100, clamped: the display scale caps at scaleCap rather than growing to infinity. */
  markerPercent: number;
  /** Where the ok/throttled boundary falls on the same 0-100 scale, for drawing zone backgrounds. */
  throttleBoundaryPercent: number;
  /** Where the throttled/banned boundary falls on the same 0-100 scale. */
  banBoundaryPercent: number;
}

/** Mirrors ReputationEntry.isBanned/isThrottled (packages/executor/src/entities/ReputationEntry.ts)
 * so the UI shows the same thresholds the backend actually enforces. The display scale is capped at
 * 1.2x banSlack - comfortably past the ban line - rather than scaling to the entity's real deficit,
 * which could be arbitrarily large. */
export function gaugePosition(input: GaugeInput): GaugePosition {
  const { opsSeen, opsIncluded, minInclusionDenominator, throttlingSlack, banSlack } = input;
  const minExpectedIncluded = Math.floor(opsSeen / minInclusionDenominator);
  const deficit = Math.max(0, minExpectedIncluded - opsIncluded);

  const zone: GaugeZone = deficit > banSlack ? "banned" : deficit > throttlingSlack ? "throttled" : "ok";

  const scaleCap = banSlack * 1.2;
  const markerPercent = Math.min(100, (Math.min(deficit, scaleCap) / scaleCap) * 100);
  const throttleBoundaryPercent = (throttlingSlack / scaleCap) * 100;
  const banBoundaryPercent = (banSlack / scaleCap) * 100;

  return { deficit, zone, markerPercent, throttleBoundaryPercent, banBoundaryPercent };
}

const ZONE_LABEL: Record<GaugeZone, string> = {
  ok: "Active",
  throttled: "Throttled",
  banned: "Banned",
};

/** A small horizontal scale from active through throttled to banned, with a marker
 * at the entity's current position. The scale is capped, not infinite - see gaugePosition. */
export function ReputationGauge({ opsSeen, opsIncluded, minInclusionDenominator, throttlingSlack, banSlack }: GaugeInput) {
  const g = gaugePosition({ opsSeen, opsIncluded, minInclusionDenominator, throttlingSlack, banSlack });

  return (
    <div
      className="inline-flex items-center gap-2"
      title={`${ZONE_LABEL[g.zone]} - ${g.deficit} inclusion${g.deficit === 1 ? "" : "s"} behind expected`}
    >
      <div className="relative h-1.5 w-20 overflow-hidden rounded-full bg-line">
        <div
          className="absolute inset-y-0 left-0 bg-pass"
          style={{ width: `${g.throttleBoundaryPercent}%` }}
        />
        <div
          className="absolute inset-y-0 bg-warn"
          style={{ left: `${g.throttleBoundaryPercent}%`, width: `${g.banBoundaryPercent - g.throttleBoundaryPercent}%` }}
        />
        <div
          className="absolute inset-y-0 right-0 bg-fail"
          style={{ left: `${g.banBoundaryPercent}%` }}
        />
        <div
          aria-hidden
          className={clsx(
            "absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-paper",
            g.zone === "ok" && "bg-pass",
            g.zone === "throttled" && "bg-warn",
            g.zone === "banned" && "bg-fail"
          )}
          style={{ left: `${g.markerPercent}%` }}
        />
      </div>
      <span className="text-[0.8125rem] text-ink-soft">{ZONE_LABEL[g.zone]}</span>
    </div>
  );
}
