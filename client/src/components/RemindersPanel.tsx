import type { Habit } from "../../../shared/types.ts";
import { useReminder } from "../hooks/useReminder.ts";

/**
 * What is still undone today, and the number on the app icon.
 *
 * **There are no timed notifications in this app and cannot be** (docs/phases.md,
 * Phase 9): sending a push needs a server, and there is none. So this panel is
 * the whole of "remind me" — a sentence when the app is open, and a badge that
 * stays on the home-screen icon after it is closed.
 *
 * The badge is opt-in behind a button, not because a toggle is nicer, but because
 * `Notification.requestPermission()` only works from a user gesture and a prompt
 * fired on load is a prompt that gets denied forever. Everything about the badge
 * degrades to "just the sentence": a browser without the API, a denied
 * permission, and a rejected `setAppBadge()` all leave a working app that simply
 * does not draw a number (AC-9.7, AC-9.8).
 */

type RemindersPanelProps = {
  /** The listed habits. Archived ones are excluded by the caller and never nagged. */
  habits: Habit[];
  /** Today's saved value per habit id. A missing id means "no record yet". */
  values: Record<number, number>;
};

export function RemindersPanel({ habits, values }: RemindersPanelProps) {
  const reminder = useReminder(habits, values);

  /** No API, or no `Notification` to ask: the button would do nothing. */
  const unavailable = !reminder.supported || reminder.permission === "unsupported";

  function badgeState(): string {
    if (unavailable) {
      return "この端末はアイコンのバッジに対応していません。画面を開いたときの表示だけになります。";
    }
    if (reminder.permission === "denied") {
      return (
        "ブラウザが通知を許可していないため、アイコンにバッジを表示できません。" +
        "端末の設定でこのサイトの通知を許可すると使えます。"
      );
    }
    if (reminder.badgeEnabled) {
      return reminder.pendingCount > 0
        ? `アイコンのバッジ: 表示中（${reminder.pendingCount}）`
        : "アイコンのバッジ: 表示中（未達成がないので数字は出ません）";
    }
    return "アイコンのバッジ: 停止中。ホーム画面に追加したアプリのアイコンに、未達成の件数を出せます。";
  }

  return (
    <section className="card" id="reminders" aria-labelledby="reminders-heading">
      <h2 className="card__title" id="reminders-heading">
        今日のリマインダー
      </h2>

      {/* role="status" so ticking off the last habit is announced rather than
          silently changing under a screen reader (AC-9.4). Polite, not an alert:
          nothing has gone wrong. */}
      {reminder.message !== null && (
        <p role="status" data-testid="reminder-message">
          {reminder.message}
        </p>
      )}

      <p className="form__hint" data-testid="badge-state">
        {badgeState()}
      </p>

      {/* Both labels are unique as substrings of every other button name on the
          page — Playwright matches an accessible name loosely by default, so a
          label sharing a fragment with another would make both ambiguous. */}
      {reminder.badgeEnabled ? (
        <button className="button button--quiet" type="button" onClick={reminder.disableBadge}>
          バッジの表示をやめる
        </button>
      ) : (
        !unavailable && (
          <button className="button button--quiet" type="button" onClick={reminder.enableBadge}>
            アイコンにバッジを表示する
          </button>
        )
      )}
    </section>
  );
}
