import { useState } from "react";
import { useBackup } from "../hooks/useBackup.ts";

/**
 * Getting the data out of this browser, and back into it.
 *
 * This panel is the app's only answer to "the phone was reset" / "Safari cleared
 * the site" / "the saved document cannot be read". Everything about it is shaped
 * by that:
 *
 *  - **It is always on screen**, including while the document is unreadable
 *    (AC-8.12). The dashboard puts it first in that state, because an iPhone has
 *    no devtools and no practical way to clear one site's storage: if the way
 *    out is not in the app, there is no way out.
 *  - **Import stages, then applies.** Choosing a file shows what is in it and
 *    changes nothing; a second, explicit press applies it (AC-8.7). Not
 *    `confirm()` — Playwright dismisses native dialogs by default, so a
 *    confirmation built on one is a confirmation nobody can test.
 *  - **Reset takes three deliberate actions**: open it, tick the acknowledgement,
 *    press the button. A single mis-tap cannot destroy a year of records.
 */

type BackupPanelProps = {
  /** `YYYY-MM-DD` from the browser: the filename and the staleness both use it. */
  today: string;
  /** True when the stored document could not be read. Changes the wording only. */
  broken: boolean;
  /** Why it could not be read, if it could not. */
  brokenMessage: string | null;
  /** Called after the stored document has been replaced or reset. */
  onDataReplaced: () => void;
};

export function BackupPanel({ today, broken, brokenMessage, onDataReplaced }: BackupPanelProps) {
  const backup = useBackup(today, onDataReplaced);

  /** Bumped to remount the file input, so re-choosing the same file re-fires. */
  const [fileKey, setFileKey] = useState(0);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetAcknowledged, setResetAcknowledged] = useState(false);

  function closeReset(): void {
    setResetOpen(false);
    setResetAcknowledged(false);
  }

  const summary = backup.pending?.summary ?? null;

  return (
    <section className="card" id="backup" aria-labelledby="backup-heading">
      <h2 className="card__title" id="backup-heading">
        バックアップ
      </h2>

      {broken && (
        // Not role="alert": the panels above already announce the failure, and a
        // second live region would talk over the first. This is a standing
        // explanation of the state, present from the first render.
        <div className="recovery" data-testid="recovery-notice">
          <p className="recovery__title">保存データを読み取れません</p>
          {brokenMessage !== null && <p className="recovery__detail">{brokenMessage}</p>}
          {/* Written as one string rather than as wrapped JSX text: JSX turns a
              line break between words into a space, and Japanese has no spaces
              — the sentence would render with gaps in the middle of it. */}
          <p className="recovery__detail">
            {"下の「バックアップファイル」から復元するか、「データを初期化する」でまっさらに戻すと、" +
              "再び使えるようになります。初期化する前に「壊れたデータをファイルに書き出す」で" +
              "今のデータを取り出しておくと、あとから復元できる可能性が残ります。"}
          </p>
          <button className="button button--quiet" type="button" onClick={backup.exportRaw}>
            壊れたデータをファイルに書き出す
          </button>
        </div>
      )}

      {/* AC-8.9: the date is always readable, whether or not there has been one. */}
      <p className="muted" data-testid="last-export">
        {backup.lastExport === null
          ? "最後のエクスポート: まだ一度もエクスポートしていません"
          : `最後のエクスポート: ${backup.lastExport}`}
      </p>

      {backup.reminder !== null && (
        <p className="backup__reminder" data-testid="export-reminder">
          {backup.reminder}
        </p>
      )}

      <div className="backup__actions">
        <button className="button" type="button" onClick={backup.exportNow} disabled={broken}>
          エクスポート
        </button>
      </div>

      <p className="form__hint">
        {"記録はこの端末のブラウザにしかありません。ときどきエクスポートして、" +
          "ファイルを別の場所に保存しておいてください。削除した習慣とその記録も含めて書き出されます。"}
      </p>

      {backup.persisted !== null && (
        <p className="form__hint" data-testid="storage-persistence">
          {backup.persisted
            ? "この端末の保存領域: 永続化されています（ブラウザが自動削除しにくい状態です）"
            : "この端末の保存領域: 永続化されていません。ホーム画面に追加して使うと消えにくくなります"}
        </p>
      )}

      <h3 className="backup__subtitle">インポート（復元）</h3>

      <div className="form__field">
        <label htmlFor="backup-file">バックアップファイル</label>
        <input
          key={fileKey}
          className="backup__file"
          id="backup-file"
          type="file"
          accept="application/json,.json"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file === undefined) return;
            void backup.stageImport(file);
          }}
        />
      </div>

      {/* AC-8.7: what the file contains, before any of it is applied. */}
      {backup.pending !== null && summary !== null && (
        <div className="backup__preview" data-testid="import-summary">
          <p className="backup__preview-title">読み込む内容</p>
          <dl className="backup__facts">
            <dt>習慣</dt>
            <dd data-testid="import-habit-count">
              {summary.habitCount} 件
              {summary.archivedCount > 0 && `（うち削除済み ${summary.archivedCount} 件）`}
            </dd>
            <dt>記録</dt>
            <dd data-testid="import-entry-count">{summary.entryCount} 件</dd>
            <dt>期間</dt>
            <dd data-testid="import-range">
              {summary.firstDate === null || summary.lastDate === null
                ? "記録なし"
                : `${summary.firstDate} 〜 ${summary.lastDate}`}
            </dd>
          </dl>
          <p className="backup__warn">いまこの端末にある記録はすべて置き換えられます。取り消せません。</p>
          <div className="backup__actions">
            <button
              className="button"
              type="button"
              onClick={() => {
                backup.confirmImport();
                setFileKey((key) => key + 1);
              }}
            >
              インポートを実行
            </button>
            <button
              className="button button--quiet"
              type="button"
              onClick={() => {
                backup.cancelImport();
                setFileKey((key) => key + 1);
              }}
            >
              インポートをやめる
            </button>
          </div>
        </div>
      )}

      {backup.error !== null && (
        <p className="form__error" role="alert">
          {backup.error}
        </p>
      )}

      {backup.notice !== null && (
        <p className="backup__notice" data-testid="backup-notice">
          {backup.notice}
        </p>
      )}

      <h3 className="backup__subtitle">初期化</h3>

      {!resetOpen ? (
        <div className="backup__actions">
          {/* Every button label in this panel is deliberately unique as a
              substring of every other one on the page: Playwright matches an
              accessible name loosely by default, and a label containing 「保存」
              would make the habit form's 「保存」 ambiguous. */}
          <button className="button button--quiet" type="button" onClick={() => setResetOpen(true)}>
            データを初期化する
          </button>
        </div>
      ) : (
        <div className="backup__danger" data-testid="reset-confirm">
          <p className="backup__warn">
            {"この端末に保存されている習慣と記録をすべて消して、まっさらな状態に戻します。" +
              "消したものは戻せません。"}
          </p>
          <label className="backup__ack">
            <input
              type="checkbox"
              checked={resetAcknowledged}
              onChange={(event) => setResetAcknowledged(event.target.checked)}
            />
            <span>記録がすべて消えることを理解しました</span>
          </label>
          <div className="backup__actions">
            <button
              className="button button--danger"
              type="button"
              disabled={!resetAcknowledged}
              onClick={() => {
                backup.reset();
                closeReset();
                setFileKey((key) => key + 1);
              }}
            >
              すべての記録を削除する
            </button>
            <button className="button button--quiet" type="button" onClick={closeReset}>
              初期化をやめる
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
