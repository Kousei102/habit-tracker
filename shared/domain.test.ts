import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addDays, formatValue, isAchieved, isISODate, toISODate } from "./domain.ts";
import type { Achievable } from "./domain.ts";

const check: Achievable = { kind: "boolean", target: null };
const minutes: Achievable = { kind: "numeric", target: 30 };
const untargeted: Achievable = { kind: "numeric", target: null };

describe("isAchieved — boolean habits", () => {
  it("counts 1 as done and 0 as not done", () => {
    assert.equal(isAchieved(check, 1), true);
    assert.equal(isAchieved(check, 0), false);
  });

  it("treats any value at or above 1 as done", () => {
    assert.equal(isAchieved(check, 2), true);
    assert.equal(isAchieved(check, 0.5), false);
  });

  it("ignores a stray target", () => {
    // A boolean habit should never carry a target, but a hand-edited row must
    // not silently change the meaning of "done".
    assert.equal(isAchieved({ kind: "boolean", target: 30 }, 1), true);
  });
});

describe("isAchieved — numeric habits", () => {
  it("is done at exactly the target", () => {
    assert.equal(isAchieved(minutes, 30), true);
  });

  it("is not done below the target", () => {
    assert.equal(isAchieved(minutes, 29), false);
    assert.equal(isAchieved(minutes, 29.999), false);
  });

  it("is done above the target", () => {
    assert.equal(isAchieved(minutes, 45), true);
  });

  it("without a target, any progress counts", () => {
    assert.equal(isAchieved(untargeted, 0), false);
    assert.equal(isAchieved(untargeted, 0.1), true);
  });

  it("treats a zero or negative target as no target", () => {
    assert.equal(isAchieved({ kind: "numeric", target: 0 }, 0), false);
    assert.equal(isAchieved({ kind: "numeric", target: 0 }, 1), true);
    assert.equal(isAchieved({ kind: "numeric", target: -5 }, 1), true);
  });
});

describe("isAchieved — degenerate values", () => {
  it("never reports NaN as done", () => {
    assert.equal(isAchieved(check, Number.NaN), false);
    assert.equal(isAchieved(minutes, Number.NaN), false);
  });

  it("never reports a negative value as done", () => {
    assert.equal(isAchieved(check, -1), false);
    assert.equal(isAchieved(minutes, -1), false);
  });
});

describe("isISODate", () => {
  it("accepts a real date", () => {
    assert.equal(isISODate("2026-03-15"), true);
    assert.equal(isISODate("2024-02-29"), true); // leap year
  });

  it("rejects malformed strings", () => {
    for (const bad of ["2026-3-15", "26-03-15", "2026/03/15", "2026-03-15T00:00:00", " 2026-03-15", ""]) {
      assert.equal(isISODate(bad), false, `expected ${JSON.stringify(bad)} to be rejected`);
    }
  });

  it("rejects days that do not exist", () => {
    assert.equal(isISODate("2026-02-31"), false);
    assert.equal(isISODate("2025-02-29"), false);
    assert.equal(isISODate("2026-13-01"), false);
    assert.equal(isISODate("2026-00-10"), false);
  });

  it("rejects non-strings", () => {
    assert.equal(isISODate(20260315), false);
    assert.equal(isISODate(null), false);
    assert.equal(isISODate(undefined), false);
  });
});

describe("toISODate", () => {
  it("uses the local calendar day, not UTC", () => {
    // Early morning local time: an implementation based on toISOString() would
    // report the previous day for any zone ahead of UTC.
    const morning = new Date(2026, 2, 15, 0, 30);
    assert.equal(toISODate(morning), "2026-03-15");

    const lateNight = new Date(2026, 2, 15, 23, 45);
    assert.equal(toISODate(lateNight), "2026-03-15");
  });

  it("zero-pads month and day", () => {
    assert.equal(toISODate(new Date(2026, 0, 5, 12, 0)), "2026-01-05");
  });
});

describe("addDays", () => {
  it("moves forward and backward", () => {
    assert.equal(addDays("2026-03-15", 1), "2026-03-16");
    assert.equal(addDays("2026-03-15", -1), "2026-03-14");
    assert.equal(addDays("2026-03-15", 0), "2026-03-15");
  });

  it("crosses month and year boundaries", () => {
    assert.equal(addDays("2026-03-01", -1), "2026-02-28");
    assert.equal(addDays("2026-12-31", 1), "2027-01-01");
    assert.equal(addDays("2024-02-28", 1), "2024-02-29");
  });

  it("is stable over a long span", () => {
    // 365 steps of one day must equal one step of 365 days: any local-time
    // arithmetic would drift by an hour at a DST boundary and lose a day.
    let stepwise = "2025-03-15";
    for (let i = 0; i < 365; i += 1) stepwise = addDays(stepwise, 1);
    assert.equal(stepwise, addDays("2025-03-15", 365));
    assert.equal(stepwise, "2026-03-15");
  });

  it("rejects a non-date string", () => {
    assert.throws(() => addDays("15/03/2026", 1), RangeError);
  });
});

describe("formatValue", () => {
  it("drops trailing zeros that SQLite's REAL storage introduces", () => {
    assert.equal(formatValue(30), "30");
    assert.equal(formatValue(0), "0");
    assert.equal(formatValue(2.5), "2.5");
  });
});
