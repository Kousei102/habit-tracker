import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApiError, NETWORK_ERROR, describeError, fallbackMessage, messageFromBody } from "./errors.ts";

/**
 * AC-6.4 is "an API failure produces something the user can read". These are the
 * words that end up on screen, so they are worth pinning: the failure modes that
 * matter (the server down, a 500 with an HTML body) are exactly the ones where
 * nothing supplies a message and a naive `catch` shows an empty string.
 */

describe("messageFromBody", () => {
  it("prefers the server's own explanation", () => {
    assert.equal(messageFromBody({ error: "習慣が見つかりません" }), "習慣が見つかりません");
  });

  it("ignores a body that carries no usable message", () => {
    for (const body of [null, undefined, "boom", 42, {}, { error: "" }, { error: "   " }, { error: 500 }, []]) {
      assert.equal(messageFromBody(body), null, `body=${JSON.stringify(body)}`);
    }
  });
});

describe("fallbackMessage", () => {
  it("never returns an empty string, for any status", () => {
    for (const status of [NETWORK_ERROR, 400, 401, 403, 404, 409, 418, 500, 502, 503]) {
      const message = fallbackMessage(status);
      assert.notEqual(message.trim(), "", `status=${status}`);
      // No English internals leaking to the screen.
      assert.doesNotMatch(message, /[A-Za-z]{4,}/, `status=${status}: ${message}`);
    }
  });

  it("says the server could not be reached when the request never landed", () => {
    assert.match(fallbackMessage(NETWORK_ERROR), /接続できませんでした/);
  });

  it("keeps the status in the text for a server error", () => {
    assert.match(fallbackMessage(500), /500/);
    assert.match(fallbackMessage(503), /503/);
  });
});

describe("describeError", () => {
  it("shows the API's message as-is", () => {
    assert.equal(describeError(new ApiError(404, "習慣が見つかりません"), "保存できませんでした"), "習慣が見つかりません");
  });

  it("wraps an unexpected error in the caller's wording", () => {
    // What a rejected fetch looks like before api.ts has had a chance to wrap it.
    assert.equal(
      describeError(new TypeError("Failed to fetch"), "記録を保存できませんでした"),
      "記録を保存できませんでした（Failed to fetch）",
    );
  });

  it("falls back to the caller's wording for anything else", () => {
    assert.equal(describeError("boom", "保存できませんでした"), "保存できませんでした");
    assert.equal(describeError(undefined, "保存できませんでした"), "保存できませんでした");
    assert.equal(describeError(new Error("  "), "保存できませんでした"), "保存できませんでした");
  });
});
