/**
 * Turning a failure into a sentence a user can read (AC-6.4, inherited by
 * AC-7.12).
 *
 * Every screen in this app ends up showing one of these strings, so they live
 * here rather than in each component: a `catch` that renders `String(cause)`
 * puts "QuotaExceededError" on screen, which tells the user nothing and is not
 * Japanese either. Pure functions and one error class, so `node:test` covers the
 * mapping directly.
 *
 * There is no network any more. The failures that remain are local and — this is
 * the part that matters — mostly invisible: `localStorage.setItem` throwing
 * because the quota is full looks exactly like a successful save unless somebody
 * reports it.
 */

/** Why a data operation failed. Decides nothing but the wording of the message. */
export type DataErrorCode =
  /** The value the user typed cannot be stored as it is. */
  | "validation"
  /** No such habit (or it has been deleted). */
  | "not-found"
  /** The saved document could not be read, or came from a newer version. */
  | "corrupt"
  /** `localStorage` is full. */
  | "quota"
  /** `localStorage` cannot be used at all (private browsing, storage disabled). */
  | "unavailable";

/**
 * Anything the data layer refuses to do.
 *
 * `message` is always the finished Japanese sentence, because the place that
 * knows *why* something failed is not the place that renders it. Components just
 * show it.
 */
export class DataError extends Error {
  code: DataErrorCode;

  constructor(code: DataErrorCode, message: string) {
    super(message);
    this.name = "DataError";
    this.code = code;
  }
}

export function validationError(message: string): DataError {
  return new DataError("validation", message);
}

export function notFoundError(message: string): DataError {
  return new DataError("not-found", message);
}

export function corruptError(message: string): DataError {
  return new DataError("corrupt", message);
}

/**
 * The quota message (AC-7.12).
 *
 * It has to say what to *do*, because the app cannot fix this by itself: the
 * data is already on the device and there is nowhere else to put it. Phase 8's
 * export is the real answer; until then the honest advice is to free space.
 */
export function quotaError(): DataError {
  return new DataError(
    "quota",
    "保存できませんでした。ブラウザの保存容量がいっぱいです。古い記録を整理するか、他のサイトのデータを削除してください",
  );
}

export function unavailableError(): DataError {
  return new DataError(
    "unavailable",
    "このブラウザではデータを保存できません。プライベートブラウジングを解除するか、サイトデータの保存を許可してください",
  );
}

/**
 * True for the exception a browser throws when `setItem` does not fit.
 *
 * Every engine signals it differently and none of them is `instanceof
 * QuotaExceededError` everywhere: Chrome throws `DOMException` code 22, Firefox
 * uses code 1014 with its own name, and Safari in private mode historically threw
 * a plain error. Testing all of the known spellings is what keeps AC-7.12 from
 * depending on which browser the reviewer opened.
 */
export function isQuotaExceeded(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null) return false;

  const error = cause as { name?: unknown; code?: unknown };
  const name = typeof error.name === "string" ? error.name : "";
  const code = typeof error.code === "number" ? error.code : -1;

  return (
    name === "QuotaExceededError" ||
    name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    // Safari's private-mode wording, which carries neither of the names above.
    name === "QUOTA_EXCEEDED_ERR" ||
    code === 22 ||
    code === 1014
  );
}

/**
 * The message to show for anything a `catch` can hand over.
 *
 * `fallback` is the caller's own wording for "this particular action failed" and
 * is used when the cause carries nothing better — never instead of a `DataError`,
 * which is more specific than any caller could be.
 */
export function describeError(cause: unknown, fallback: string): string {
  if (cause instanceof DataError) return cause.message;
  if (cause instanceof Error && cause.message.trim() !== "") return `${fallback}（${cause.message}）`;
  return fallback;
}
