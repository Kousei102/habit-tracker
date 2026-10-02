import { useCallback, useEffect, useMemo, useState } from "react";
import type { Habit } from "../../../shared/types.ts";
import { badgeCount, pendingHabits, reminderMessage } from "../data/reminder.ts";
import * as store from "../data/store.ts";
import type { BadgePermission } from "../pwa.ts";
import {
  notificationPermission,
  requestNotificationPermission,
  setBadge,
  supportsBadge,
} from "../pwa.ts";

/**
 * The reminder panel's state, minus the markup.
 *
 * Two things live here that the pure module cannot own: the badge preference
 * (which is stored) and the notification permission (which only the browser can
 * answer). Everything else is derived, so there is no state to fall out of sync
 * with the habits on screen — the count follows `values` on every render.
 *
 * **No clock.** "Today" never appears in this hook: `values` is already one day's
 * records, chosen by the caller, so the badge follows the day change for free
 * when `useToday` hands the dashboard a new date.
 */

export type UseReminder = {
  /** What to say about today, or null for "say nothing" (AC-9.2). */
  message: string | null;
  /** How many habits are not done yet — the number on the icon (AC-9.6). */
  pendingCount: number;
  /** Whether the user opted in and the badge is being drawn. */
  badgeEnabled: boolean;
  /** The browser's answer, so the panel can say why the badge is unavailable. */
  permission: BadgePermission;
  /** Whether this browser has the Badging API at all. */
  supported: boolean;
  /**
   * Asks for permission and turns the badge on if it is granted.
   *
   * **Call from a click only.** Safari rejects a permission request that no user
   * gesture drove, which is why this is not done on mount (AC-9.5).
   */
  enableBadge: () => void;
  disableBadge: () => void;
};

export function useReminder(habits: Habit[], values: Record<number, number>): UseReminder {
  const [badgeEnabled, setBadgeEnabled] = useState<boolean>(() => store.getBadgeEnabled());
  const [permission, setPermission] = useState<BadgePermission>(() => notificationPermission());
  // Capability, not state: it cannot change while the page is open, and reading
  // it once keeps the render pure.
  const supported = useMemo(() => supportsBadge(), []);

  const pending = useMemo(() => pendingHabits(habits, values), [habits, values]);
  const pendingCount = badgeCount(pending);
  const message = useMemo(() => reminderMessage(pending, habits.length), [pending, habits.length]);

  useEffect(() => {
    // Turning the badge off has to push zero, not merely stop pushing: the number
    // is drawn by the OS and outlives the page that set it, so a badge left
    // behind would keep nagging after the user asked it to stop.
    setBadge(badgeEnabled ? pendingCount : 0);
  }, [badgeEnabled, pendingCount]);

  const enableBadge = useCallback(() => {
    void (async () => {
      const result = await requestNotificationPermission();
      setPermission(result);
      if (result !== "granted") return;

      store.setBadgeEnabled(true);
      setBadgeEnabled(true);
    })();
  }, []);

  const disableBadge = useCallback(() => {
    store.setBadgeEnabled(false);
    setBadgeEnabled(false);
  }, []);

  return {
    message,
    pendingCount,
    badgeEnabled,
    permission,
    supported,
    enableBadge,
    disableBadge,
  };
}
