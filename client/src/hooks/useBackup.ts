import { useCallback, useEffect, useState } from "react";
import type { BackupSummary } from "../data/backup.ts";
import {
  buildExport,
  exportFilename,
  exportReminder,
  parseImport,
  serializeExport,
} from "../data/backup.ts";
import type { AppData } from "../data/document.ts";
import * as store from "../data/store.ts";
import { downloadText } from "../download.ts";
import { describeError } from "../errors.ts";
import { requestPersistentStorage } from "../pwa.ts";

/**
 * Everything the backup panel does, minus the markup.
 *
 * The shape it enforces is the one AC-8.7 and AC-8.8 are about: choosing a file
 * only ever *stages* it. `pending` holds a fully validated document and the
 * summary the user is shown; nothing reaches storage until `confirmImport` is
 * called. A file that fails validation never produces a `pending` at all, so
 * there is no state from which a broken file could be applied by accident.
 */

export type BackupStatus = {
  /** `YYYY-MM-DD` of the last export on this device, or null (AC-8.9). */
  lastExport: string | null;
  /** A quiet nudge, or null. Deliberately not shown on every visit. */
  reminder: string | null;
  /** Whether the browser has promised to keep this origin's data (AC-8.4). */
  persisted: boolean | null;
};

export type PendingImport = {
  data: AppData;
  summary: BackupSummary;
  filename: string;
};

export type UseBackup = BackupStatus & {
  /** Set when the last action failed; shown to the user, never swallowed. */
  error: string | null;
  /** Set after a successful import or reset, so the screen confirms it happened. */
  notice: string | null;
  /** The staged file, awaiting the explicit confirmation of AC-8.7. */
  pending: PendingImport | null;
  exportNow: () => void;
  /** Reads and validates a chosen file. Writes nothing. */
  stageImport: (file: File) => Promise<void>;
  cancelImport: () => void;
  /** Applies the staged document. The only destructive step. */
  confirmImport: () => void;
  reset: () => void;
  /** Downloads the raw stored bytes — the escape hatch for a corrupt document. */
  exportRaw: () => void;
};

/**
 * @param today   `YYYY-MM-DD` from the browser, used for the filename and the
 *                staleness of the last export. Never read from a clock here.
 * @param onReplaced Called after the stored document has been replaced, so the
 *                rest of the dashboard can re-read it.
 */
export function useBackup(today: string, onReplaced: () => void): UseBackup {
  const [lastExport, setLastExport] = useState<string | null>(() => store.getLastExportDate());
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingImport | null>(null);
  /** Whether there is anything worth backing up; decides if the nudge appears. */
  const [hasData, setHasData] = useState(false);

  const refreshHasData = useCallback(() => {
    try {
      setHasData(store.getHabits(true).length > 0);
    } catch {
      // An unreadable document is not "no data" — but it is also not something
      // to nag about backing up. The recovery UI is what matters in that state.
      setHasData(false);
    }
  }, []);

  useEffect(() => {
    refreshHasData();
  }, [refreshHasData]);

  useEffect(() => {
    let cancelled = false;
    void requestPersistentStorage().then((granted) => {
      if (!cancelled) setPersisted(granted);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const exportNow = useCallback(() => {
    setError(null);
    setNotice(null);
    try {
      const file = buildExport(store.load(), new Date().toISOString());
      downloadText(exportFilename(today), serializeExport(file));

      store.setLastExportDate(today);
      setLastExport(today);
      setNotice(
        `${file.habits.length} 件の習慣と ${file.entries.length} 件の記録を書き出しました。`,
      );
    } catch (cause) {
      setError(describeError(cause, "エクスポートできませんでした"));
    }
  }, [today]);

  const exportRaw = useCallback(() => {
    setError(null);
    try {
      const raw = store.readRawDocument();
      if (raw === null || raw === "") {
        setError("保存されているデータがありません");
        return;
      }
      // A `.txt` extension, not `.json`: these bytes are by definition not valid
      // JSON, and naming them `.json` would invite the user to try importing
      // them and be told no.
      downloadText(`habit-tracker-${today}-破損データ.txt`, raw, "text/plain");
      setNotice("読み取れなかったデータをそのままファイルに書き出しました。");
    } catch (cause) {
      setError(describeError(cause, "ファイルに書き出せませんでした"));
    }
  }, [today]);

  const stageImport = useCallback(async (file: File) => {
    setError(null);
    setNotice(null);
    setPending(null);

    let text: string;
    try {
      text = await file.text();
    } catch (cause) {
      setError(describeError(cause, "ファイルを読み込めませんでした"));
      return;
    }

    const result = parseImport(text);
    if (result.status === "error") {
      // Nothing was written, and nothing will be: the staged state is left empty
      // so there is no confirm button to press (AC-8.8).
      setError(result.message);
      return;
    }

    setPending({ data: result.data, summary: result.summary, filename: file.name });
  }, []);

  const cancelImport = useCallback(() => {
    setPending(null);
    setError(null);
  }, []);

  const confirmImport = useCallback(() => {
    if (pending === null) return;

    setError(null);
    try {
      store.replaceAll(pending.data);
      setPending(null);
      setNotice(
        `${pending.summary.habitCount} 件の習慣と ${pending.summary.entryCount} 件の記録を読み込みました。`,
      );
      onReplaced();
      refreshHasData();
    } catch (cause) {
      // The write failed, so the previous document is still there — say so
      // rather than leaving the screen looking as if the restore worked.
      setError(describeError(cause, "インポートできませんでした"));
    }
  }, [pending, onReplaced, refreshHasData]);

  const reset = useCallback(() => {
    setError(null);
    try {
      store.resetAll();
      setPending(null);
      setNotice("保存データを初期化しました。");
      onReplaced();
      refreshHasData();
    } catch (cause) {
      setError(describeError(cause, "初期化できませんでした"));
    }
  }, [onReplaced, refreshHasData]);

  return {
    lastExport,
    reminder: exportReminder(lastExport, today, hasData),
    persisted,
    error,
    notice,
    pending,
    exportNow,
    stageImport,
    cancelImport,
    confirmImport,
    reset,
    exportRaw,
  };
}
