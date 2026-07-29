/**
 * Turning a failure into a sentence a user can read (AC-6.4).
 *
 * Every screen in this app ends up showing one of these strings, so they live
 * here rather than in each component: a `catch` that renders
 * `String(cause)` puts "TypeError: Failed to fetch" on screen, which tells the
 * user nothing and is not Japanese either. Pure functions, so `node:test` covers
 * the mapping directly.
 */

/**
 * Status carried by an error that never reached a server at all — the fetch
 * itself rejected. Not a real HTTP status; 0 is what `XMLHttpRequest` has always
 * used for the same situation, and it keeps the type one number.
 */
export const NETWORK_ERROR = 0;

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/**
 * The server's own message, when it sent one.
 *
 * Every route in this app answers failures with `{"error": "…"}` in Japanese, so
 * that text is always better than anything generated here. Anything else —
 * an HTML error page from a proxy, an empty body — is not shown to the user.
 */
export function messageFromBody(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;

  const error = (body as { error?: unknown }).error;
  if (typeof error !== "string") return null;

  const trimmed = error.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * What to say when the response carried no usable message.
 *
 * The status is kept in the text on purpose: it is the one detail that makes a
 * bug report actionable, and a user who cannot use it can still ignore it.
 */
export function fallbackMessage(status: number): string {
  if (status === NETWORK_ERROR) {
    return "サーバーに接続できませんでした。通信状態を確認して、もう一度お試しください";
  }
  if (status === 401) return "ログインの有効期限が切れました。もう一度ログインしてください";
  if (status === 404) return "対象が見つかりませんでした（404）";
  if (status >= 500) return `サーバーでエラーが発生しました（${status}）`;
  if (status >= 400) return `リクエストが受け付けられませんでした（${status}）`;
  return `通信に失敗しました（${status}）`;
}

/**
 * The message to show for anything a `catch` can hand over.
 *
 * `fallback` is the caller's own wording for "this particular action failed" and
 * is used when the cause carries nothing better — never instead of the server's
 * explanation, which is more specific than any caller could be.
 */
export function describeError(cause: unknown, fallback: string): string {
  if (cause instanceof ApiError) return cause.message;
  if (cause instanceof Error && cause.message.trim() !== "") return `${fallback}（${cause.message}）`;
  return fallback;
}
