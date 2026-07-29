import { useEffect, useState } from "react";
import { toISODate } from "../../../shared/domain.ts";

/**
 * The browser's calendar day, kept current.
 *
 * **This is the only place in the app that asks what day it is** (docs/design.md
 * §1: the server never derives a date). Everything below the dashboard receives
 * the answer as a `YYYY-MM-DD` string.
 *
 * It used to be read once, on mount — which is fine until the tab is left open
 * past midnight. Then "今日の習慣" is yesterday's, a tick lands on yesterday's
 * date, the streak is computed as of the wrong day and the heatmap's right-hand
 * edge is one cell short. All of those are silent: nothing on screen says the
 * page is a day behind.
 *
 * The value only ever changes when the *date* changes, never merely when the
 * clock is read, so it stays a stable dependency: a component that fetches on
 * `[today]` fetches once per day, not once per render.
 */

/** How often the date is re-read. A minute is imperceptible and costs nothing. */
const CHECK_INTERVAL_MS = 60_000;

export function useToday(): string {
  const [today, setToday] = useState(() => toISODate(new Date()));

  useEffect(() => {
    // Returning `current` when the day has not changed is what keeps the string
    // identity stable — React bails out of the update entirely.
    const check = () =>
      setToday((current) => {
        const now = toISODate(new Date());
        return now === current ? current : now;
      });

    const timer = setInterval(check, CHECK_INTERVAL_MS);

    // A backgrounded tab has its timers throttled to the point of stopping, so
    // coming back to it is the moment the date is most likely to be stale.
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);

    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("focus", check);
    };
  }, []);

  return today;
}
