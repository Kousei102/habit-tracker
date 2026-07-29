import { useCallback, useEffect, useRef, useState } from "react";
import type { Entry } from "../../../shared/types.ts";
import * as api from "../api.ts";

/**
 * A whole year of records, fetched once.
 *
 * The heatmap needs ~371 days of history, and `GET /api/entries?from=&to=`
 * returns it in a single request — re-asking for it after every write would put
 * a year-sized read behind each keystroke. Instead the write's own response is
 * folded in through `applyEntry`: the server already told us what it stored, so
 * the map can stay current without another round trip.
 *
 * Both bounds are `YYYY-MM-DD` strings the caller derived from the browser
 * clock; nothing here asks what day it is.
 */

export type EntryHistoryStatus = "loading" | "ready" | "error";

export type UseEntryHistory = {
  /** Every record in the window, including those of archived habits. */
  entries: Entry[];
  status: EntryHistoryStatus;
  /** Set only while `status` is "error"; never swallowed silently (AC-6.4). */
  error: string | null;
  reload: () => Promise<void>;
  /** Folds one saved record into the cached year, replacing any older value. */
  applyEntry: (entry: Entry) => void;
};

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function useEntryHistory(from: string, to: string): UseEntryHistory {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [status, setStatus] = useState<EntryHistoryStatus>("loading");
  const [error, setError] = useState<string | null>(null);

  // A response that arrives after unmount must not call setState.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Two loads can overlap (a manual reload during the initial one); only the
  // newest answer may win, or a stale year overwrites a fresh one.
  const latestRequest = useRef(0);

  const reload = useCallback(async () => {
    const request = (latestRequest.current += 1);

    try {
      const loaded = await api.getEntries(from, to);
      if (!mounted.current || request !== latestRequest.current) return;

      setEntries(loaded);
      setError(null);
      setStatus("ready");
    } catch (cause) {
      if (!mounted.current || request !== latestRequest.current) return;
      // A 401 already sends the app back to the login screen (api.ts); anything
      // else has to be shown rather than left as an empty grid, which would be
      // indistinguishable from "you did nothing all year".
      setError(messageOf(cause));
      setStatus("error");
    }
  }, [from, to]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const applyEntry = useCallback((entry: Entry) => {
    if (!mounted.current) return;

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
