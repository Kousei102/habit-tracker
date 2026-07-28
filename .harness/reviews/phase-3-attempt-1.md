# Phase 3 review — attempt 1
VERDICT: PASS

## 受け入れ基準

| ID | 判定 | 根拠 |
|----|------|------|
| AC-3.1 | PASS | e2e/specs/phase3-habits.spec.ts:173（作成前に 0 件を確認 → 追加 → チェックボックスとして描画 → リロード後も 1 件）。ネガティブコントロールは同 :195（空白名の送信で行が増えない） |
| AC-3.2 | PASS | e2e/specs/phase3-habits.spec.ts:207（行の可視テキストが `0 / 30 分` を含む。リロード後も同一） |
| AC-3.3 | PASS | e2e/specs/phase3-habits.spec.ts:222（PUT が 200 であることを確認したうえで 達成 → リロード後もチェック済み・達成）。解除側は同 :242（リロード後も 未達成） |
| AC-3.4 | PASS | e2e/specs/phase3-habits.spec.ts:259（目標 5 km に対し 3 → 未達成 / 5 → 達成 / 7.5 → 達成。各段でリロードして入力値・進捗テキスト・達成表示を再確認） |
| AC-3.5 | PASS | e2e/specs/phase3-habits.spec.ts:290（名前と目標値を編集 → `0 / 50 個`、旧名は 0 件、リロード後も維持、habit id が同一）。チェック式の改名は同 :316 |
| AC-3.6 | PASS | e2e/specs/phase3-habits.spec.ts:340（一覧から消え、リロード後も消えている。`.harness/tmp/e2e.db` を直読して `entries` に (habit_id, 2026-03-15, 1) が残存、`habits.archived_at` が非 NULL）。DB の独立確認結果は後述 |
| AC-3.7 | PASS | e2e/specs/phase3-habits.spec.ts:374（存在しない id と、DB に直接仕込んだ他ユーザー `intruder` の habit の双方が 404。**本文がバイト単位で一致**。他ユーザー habit に entry は書かれず、`GET /api/habits` / `GET /api/entries` にも現れない） |
| AC-3.8 | PASS | e2e/specs/phase3-habits.spec.ts:403（同一日付に 10 → 25 を PUT。DB 上 1 行、値 25。別日付は別行になることも確認）。スキーマ側も `PRIMARY KEY (habit_id, date)` + `ON CONFLICT DO UPDATE`（server/src/migrations.ts:48, server/src/routes/entries.ts:148） |

## 特に依頼のあった点

### `isAchieved()` が唯一の達成判定になっているか — 二重化なし

`shared/domain.ts:29` の `isAchieved()` を呼んでいるのは **client/src/components/TodayPanel.tsx:97 の 1 箇所のみ**（`grep -rn "isAchieved" client server shared` で確認）。
そこで得た `achieved` からチェックボックスの `checked`（:144）とバッジの `達成 / 未達成`（:185）の両方が派生しており、表示系の中でも判定は 1 回しか行われていません。
サーバー側には Phase 3 時点で達成判定そのものが存在せず（`value >= target` 相当の比較は `shared/domain.ts` 以外に無し）、`habits.ts:92` の言及はコメントのみです。Phase 4 の stats がここを呼ぶ限り「画面は達成、ストリークは 0」の乖離は構造的に起きません。

なお `client/src/components/TodayPanel.tsx:97` は保存中の楽観値 `pendingValue ?? value` を渡すため、保存が失敗した瞬間にサーバー値へ戻ります（下記コントロールで実測）。

### AC-3.6 の論理削除 — DB 直接確認

E2E とは別に、実行後の `.harness/tmp/e2e.db` を直接読んで確認しました。

```
habits:  {"id":7,"name":"腕立て伏せ","archived_at":"2026-07-28T07:41:53.707Z"}
entries: {"habit_id":7,"date":"2026-03-15","value":1}
```

削除後も `habits` 行自体が残り `archived_at` が入り、`entries` の記録が保持されています。物理削除であれば `entries` の外部キーが `ON DELETE CASCADE`（server/src/migrations.ts:44）なので記録ごと消えますが、そうなっていません。
また `entries` の重複チェック（`GROUP BY habit_id, date HAVING COUNT(*) > 1`）は 0 件、`typeof(value)` は全行 `real`、`typeof(target)` も `real` で、値が文字列として bind される類の不具合はありません。

### AC-3.7 — 存在漏洩の有無

`intruder` ユーザー（user_id=2）とその habit を DB に直接 INSERT し、実在する id であることを確認したうえで e2e ユーザーのセッションから PUT しています。
存在しない id（987654321）と他ユーザーの id で、ステータス（404）と本文（`{"error":"習慣が見つかりません"}`）が完全一致することを assert 済み。`server/src/routes/entries.ts:142` が `findHabit(db, userId, habitId)`（`WHERE id = ? AND user_id = ?`）を通しており、403 と 404 を撃ち分ける分岐がそもそも存在しません。

### negative control（Phase 1・2 から維持）

- **保存失敗の握り潰し**: e2e/specs/phase3-habits.spec.ts:436。`PUT /api/entries/**` を 500 に差し替えてチェック → 行内に `role="alert"` が出ること、ルート解除＋リロード後にチェックが外れ 未達成 に戻ること、`entries` に 0 行であることを確認。無言で成功に見せる実装であればここで落ちます。
- **リロード後に実は消えている**: AC-3.1 / 3.3 / 3.4 / 3.5 の全てでリロード後に再 assert。加えて AC-3.3 の解除、AC-3.5 の habit id 同一性で「作り直し」を弾いています。
- **物理削除**: AC-3.6 で DB を直読。
- **空入力での偽成功**: :195。

すべての assert は role とアクセシブルネーム（`getByRole("list"/"checkbox"/"spinbutton"/"button")`、`getByLabel`、`getByText`）で書いており、`data-testid` には依存していません（`habit-state` / `habit-progress` は使わず、可視テキスト `達成` / `未達成` / `0 / 30 分` で判定）。時刻は `e2e/fixtures.ts` の `page.clock.install({ time: FIXED_NOW })` で 2026-03-15 に固定。実行時の実日付は 2026-07-28 ですが、DB に書かれた `entries.date` は全て `2026-03-15` であり、固定が実際に効いていること・日付がクライアント由来であることが裏取りできています。

## ブロッキング指摘

なし。

## 非ブロッキングの所見

1. **`client/src/api.ts:54-59` — `Accept` ヘッダが body 付きリクエストで消える。**
   ```ts
   const response = await fetch(path, {
     headers: { Accept: "application/json", ...init?.headers },
     keepalive: options?.keepalive ?? false,
     ...init,                       // ← init.headers が上の headers を丸ごと上書き
   });
   ```
   `sendJson()` は `headers: { "Content-Type": "application/json" }` を `init` に入れるため、login / POST / PATCH / PUT では `Accept: application/json` が付きません。サーバーが常に JSON を返す現状では実害なしですが、既定値が死んでいます（Phase 2 からの持ち越し）。同様に `keepalive` は `...init` より前にあるので今は残りますが、将来 `init` に `keepalive` を入れた瞬間に静かに壊れる並びです。

2. **数値入力がキーストロークごとに PUT を送る**（client/src/components/TodayPanel.tsx:124-130）。`30` と打つと `3` が一度保存されます。最終値は正しく、AC 上の問題はありませんが、Phase 4 で達成率やストリークを見ながら入力している最中は中間値が反映されます。デバウンス（あるいは blur 時保存）を検討する余地があります。

3. **`PATCH /api/habits/:id` で numeric 習慣の目標値を「無し」に戻せない**（server/src/routes/habits.ts の `parseUpdate`）。`{"target": null}` は `undefined` ではないため `parseTarget(null)` に入り 400 になります。現在の UI はこの経路を踏まないので実害はありません。

4. **削除に確認も取り消しもない**（TodayPanel.tsx:202-211）。builder の判断理由は妥当で、論理削除なので復旧可能ですが、UI からは復旧手段がありません。Phase 6 の仕上げで undo を検討してもよい箇所です。

5. **既定色は archived を含む全習慣数でローテーションしている**（habits.ts の `SELECT COUNT(*) ... FROM habits WHERE user_id = ?`）。色の重複が起きうるだけで Phase 5 の AC には触れません。

## builder 申し送りの検証結果

| # | 申し送り | 実測 |
|---|----------|------|
| 1 | アーカイブ済み習慣への PUT / PATCH は 404 | PUT について e2e:464 で 404 を確認 |
| 2 | `value: 0` は行を残して 0 で保存 | DB に `(habit_id 4, 2026-03-15, 0)` が残存。UI は 未達成 |
| 3 | `kind` 変更は PATCH で 400 | コード確認のみ（AC 外） |
| 4 | `target` は小数も許容 | `7.5` の記録・保存を e2e:259 で確認（target 側は未検証） |
| 5 | 数値入力は変更ごとに即保存 | 確認。所見 2 参照 |
| 6 | 色はサーバーがローテーション | DB 上 blue/green/purple/orange/pink の巡回を確認 |
| 7 | `GET /api/entries` の from/to は省略可 | e2e:374 でパラメータ無し呼び出しが 200 + 配列を返すことを確認 |

## 実行結果

- `npx tsc --noEmit`: PASS
- `npm run typecheck`（root / server / client）: PASS
- `npm test`: 82 passed / 0 failed（23 suites。うち `isAchieved` 系 3 suite、`PUT /api/entries` / `GET /api/entries` / `POST|PATCH|DELETE /api/habits` を含む）
- `npx playwright test`: **31 passed / 0 failed**（Phase 1: 5 / Phase 2: 13 / Phase 3: 13）。Phase 1・2 の回帰なし
