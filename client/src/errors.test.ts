import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DataError,
  describeError,
  isQuotaExceeded,
  quotaError,
  unavailableError,
  validationError,
} from "./errors.ts";

/**
 * AC-7.12 (inheriting AC-6.4) is "a failed save produces something the user can
 * read". These are the words that end up on screen, so they are worth pinning:
 * the failure that matters — `localStorage` refusing a write — arrives as a
 * `DOMException` whose own message is English, and a naive `catch` shows either
 * that or nothing at all.
 */

describe("the messages that reach the screen", () => {
  it("never returns an empty string, and never leaks English", () => {
    for (const error of [quotaError(), unavailableError()]) {
      assert.notEqual(error.message.trim(), "");
      assert.doesNotMatch(error.message, /[A-Za-z]{4,}/, error.message);
    }
  });

  it("tells the user what to do about a full store, not just that it is full", () => {
    assert.match(quotaError().message, /容量/);
    assert.match(quotaError().message, /削除|整理/);
  });
});

describe("isQuotaExceeded", () => {
  it("recognises the spelling of every engine that has one", () => {
    const cases: unknown[] = [
      { name: "QuotaExceededError" },
      // Chrome: the legacy DOMException code, with a name that says nothing.
      { name: "Error", code: 22 },
      // Firefox.
      { name: "NS_ERROR_DOM_QUOTA_REACHED", code: 1014 },
      // Older Safari, private browsing.
      { name: "QUOTA_EXCEEDED_ERR" },
    ];

    for (const cause of cases) {
      assert.equal(isQuotaExceeded(cause), true, JSON.stringify(cause));
    }
  });

  it("does not mistake anything else for a full store", () => {
    for (const cause of [null, undefined, "boom", 22, new Error("SecurityError"), { name: "TypeError" }]) {
      assert.equal(isQuotaExceeded(cause), false, String(cause));
    }
  });
});

describe("describeError", () => {
  it("shows a DataError's own message as-is", () => {
    assert.equal(
      describeError(validationError("習慣名を入力してください"), "保存できませんでした"),
      "習慣名を入力してください",
    );
    assert.equal(describeError(quotaError(), "保存できませんでした"), quotaError().message);
  });

  it("wraps an unexpected error in the caller's wording", () => {
    // What a browser exception looks like before the store has wrapped it.
    assert.equal(
      describeError(new TypeError("Cannot read properties of null"), "記録を保存できませんでした"),
      "記録を保存できませんでした（Cannot read properties of null）",
    );
  });

  it("falls back to the caller's wording for anything else", () => {
    assert.equal(describeError("boom", "保存できませんでした"), "保存できませんでした");
    assert.equal(describeError(undefined, "保存できませんでした"), "保存できませんでした");
    assert.equal(describeError(new Error("  "), "保存できませんでした"), "保存できませんでした");
  });

  it("keeps a DataError distinguishable by code, not by message matching", () => {
    const error = new DataError("not-found", "習慣が見つかりません");
    assert.equal(error.code, "not-found");
    assert.equal(error.name, "DataError");
    assert.ok(error instanceof Error);
  });
});
