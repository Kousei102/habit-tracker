import { useCallback, useEffect, useState } from "react";
import type { Entry } from "../../../shared/types.ts";
import * as store from "../data/store.ts";
import { describeError } from "../errors.ts";

/**
 * A whole year of records, read once.
 *
 * The heatmap needs ~371 days of history. Re-reading and re-sorting all of it
 * after every keystroke would put a year-sized scan behind each one, so the
 * write's own result is folded in through `applyEntry` instead: the store already
 * told us what it stored, and the map can stay current without a second pass.
 *
 * Both bounds are `YYYY-MM-DD` strings the caller derived from the browser
 * clock; nothing here asks what day it is.
 */

export type EntryHistoryStatus = "loading" | "ready" | "error";

export type UseEntryHistory = {
  /** Every record in the window, including those of archived habits. */
  entries: Entry[];
  status: EntryHistoryStatus;
  /** Set only while `status` is "error"; never swallowed silently (AC-7.12). */
  error: string | null;
  reload: () => void;
  /** Folds one saved record into the cached year, replacing any older value. */
  applyEntry: (entry: Entry) => void;
};

export function useEntryHistory(from: string, to: string): UseEntryHistory {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [status, setStatus] = useState<EntryHistoryStatus>("loading");
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    try {
      setEntries(store.getEntries(from, to));
      setError(null);
      setStatus("ready");
    } catch (cause) {
      // An empty grid is indistinguishable from "you did nothing all year", so a
      // failed read has to say so out loud.
      setError(describeError(cause, "データを読み込めませんでした"));
      setStatus("error");
    }
  }, [from, to]);

  useEffect(() => {
    reload();
  }, [reload]);

  const applyEntry = useCallback((entry: Entry) => {
    setEntries((current) => {
      const index = current.findIndex(
        (candidate) => candidate.habit_id === entry.habit_id && candidate.date === entry.date,
      );
      if (index === -1) return [...current, entry];

      const next = current.slice();
      next[index] = entry;
      return next;
    });
  }, []);

  return { entries, status, error, reload, applyEntry };
}
