import { describe, it, expect } from "vitest";
import { gaugePosition } from "./ReputationGauge";

const THRESHOLDS = { minInclusionDenominator: 10, throttlingSlack: 10, banSlack: 50 };

describe("gaugePosition", () => {
  it("sits at the zero deficit when nothing is seen yet", () => {
    const g = gaugePosition({ opsSeen: 0, opsIncluded: 0, ...THRESHOLDS });
    expect(g.deficit).toBe(0);
    expect(g.zone).toBe("ok");
  });

  it("stays in the ok zone while deficit is within throttlingSlack", () => {
    // minExpectedIncluded = floor(100/10) = 10, opsIncluded = 0 -> deficit 10 == throttlingSlack, still ok
    const g = gaugePosition({ opsSeen: 100, opsIncluded: 0, ...THRESHOLDS });
    expect(g.deficit).toBe(10);
    expect(g.zone).toBe("ok");
  });

  it("enters the throttled zone once deficit exceeds throttlingSlack", () => {
    // minExpectedIncluded = floor(200/10) = 20, opsIncluded = 0 -> deficit 20 > 10
    const g = gaugePosition({ opsSeen: 200, opsIncluded: 0, ...THRESHOLDS });
    expect(g.deficit).toBe(20);
    expect(g.zone).toBe("throttled");
  });

  it("enters the banned zone once deficit exceeds banSlack", () => {
    // minExpectedIncluded = floor(1000/10) = 100, opsIncluded = 0 -> deficit 100 > 50
    const g = gaugePosition({ opsSeen: 1000, opsIncluded: 0, ...THRESHOLDS });
    expect(g.deficit).toBe(100);
    expect(g.zone).toBe("banned");
  });

  it("clamps the marker position at 100% once the deficit reaches the display cap, instead of scaling to infinity", () => {
    const atCap = gaugePosition({ opsSeen: 1000, opsIncluded: 0, ...THRESHOLDS });
    const wayOver = gaugePosition({ opsSeen: 100_000, opsIncluded: 0, ...THRESHOLDS });
    expect(atCap.markerPercent).toBeLessThanOrEqual(100);
    expect(wayOver.markerPercent).toBe(atCap.markerPercent === 100 ? 100 : wayOver.markerPercent);
    expect(wayOver.markerPercent).toBe(100);
  });

  it("never reports a negative deficit when opsIncluded exceeds the minimum expected", () => {
    const g = gaugePosition({ opsSeen: 5, opsIncluded: 100, ...THRESHOLDS });
    expect(g.deficit).toBe(0);
    expect(g.zone).toBe("ok");
  });
});
