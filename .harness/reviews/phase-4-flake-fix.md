# Phase 3 spec の flake 修正（Phase 4 PASS 後の追補）

対象: `e2e/specs/phase3-habits.spec.ts:195` `AC-3.1 control: submitting an empty name adds nothing`

**結論: 見立ては正しい。原因は E2E 側（fixture と spec）で、製品コードにバグはない。** 修正は `e2e/` 配下のみ。`retries: 0` は変更していない。`waitForTimeout` は使用していない（`e2e/` 全体で 0 件）。

## 1. 確認したこと

### 1.1 まず事実（推測ではない部分）

- `client/src/components/TodayPanel.tsx:59` — `習慣一覧` の `<ul>` は `status === "ready" && habits.length > 0` のときだけレンダリングされる。ロード中は `<ul>` そのものが DOM に存在しない（`:48` が `読み込み中…` を出す）。
- `e2e/fixtures.ts` の `loginAs` が待っていたのは `dashboardHeading` の表示まで。ダッシュボードの見出しは `GET /api/auth/me` の解決で描画され、習慣一覧は別レスポンス `GET /api/habits` の解決で描画される。**2 つは別のレスポンスなので、この隙間は常に存在し、幅だけが実行ごとに変わる。**
- `locator.count()` は自動待機しない即時評価。

### 1.2 再現（トレースではなく、意図的な再現で確定させた）

コーディネーター実行時のレポートは残っていませんでした（`.harness/tmp` は私の再実行で上書き済み）。そこで推測で書かず、**隙間を人為的に広げて決定的に再現**させました。使い捨ての spec で `GET /api/habits` だけを 1500ms 遅延させ、当時の fixture が保証していたのと同じ条件（`dashboardHeading` の表示のみ）で止めて計測:

1. `count()` はその隙間で **0 を返す**（習慣は DB に存在し、遅延解除後は 1 件描画される）。→ 見立ての前半を確認。
2. 落ちたテストの本体をそのまま実行すると、**同じ行・同じ署名で失敗**する:

```
e2e/specs/...:58 › await expect(habitList(page).getByRole("listitem")).toHaveCount(before);
Error: expect(locator).toHaveCount(expected) failed
Expected: 0
Received: 1
  - waiting for getByRole('list', { name: '習慣一覧' }).getByRole('listitem')
  - 14 × locator resolved to 1 element  - unexpected value "1"
```

再現用 spec は確認後に削除済み（リポジトリには残していません）。

### 1.3 見立てへの補足 — レース は両方向にある

再現の途中で分かったことです。`before = 0` になっただけでは、必ずしも失敗しません。

- `before = 0` で、**reload 後も一覧が未描画のうちに最初のポーリングが走る**と、`toHaveCount(0)` は**その場で成立して通る**。テストは「通った」ように見えて何も検証していません（vacuous pass）。
- `before = 0` で、**reload 後に一覧が描画されてからポーリングが走る**と、`Expected: 0 / Received: 1` で落ちる。

つまりこのテストは「1 回目 42 passed / 2 回目 43 passed」という見え方の通り、**落ちるか、黙って無意味に通るか**の二択でした。後者のほうが厄介なので、修正は「一覧がロード済みであること」を両方の測定点で保証する形にしています。

## 2. 修正内容

### 2.1 `e2e/fixtures.ts` — 一覧のロード完了を fixture 側の保証にした

`expectDashboardReady(page)` を追加し、`loginAs` から呼ぶようにしました（=`loggedInPage` fixture 全体に効きます）。

待機条件は **positive locator**（「何かが現れるのを待つ」）にしてあります。`読み込み中…` が消えるのを待つ形にすると、**まだ何も描画されていないページでも成立してしまう**ため、同じ罠を作り直すことになるからです。各パネルについて「ロードが決着した 3 つの終状態」のいずれかが見えるまで待ちます:

- 今日のパネル: `習慣一覧` のリスト / `習慣がまだ登録されていません。` / `習慣を読み込めませんでした`
- 統計パネル: `習慣の統計` のリスト / `習慣を登録すると…` / `統計を読み込めませんでした`

エラー状態も終状態に含めているのは、API が落ちたときに「readiness 待ちのタイムアウト」という無関係な失敗に化けさせないためです（本来のアサーションで落ちてほしい）。

### 2.2 `e2e/specs/phase3-habits.spec.ts` — 測定点を 2 か所とも固定した

`AC-3.1 control` を次のように変更:

- **自前の習慣を 1 件作ってから数える。** `createBooleanHabit` は行が見えるまで待つので、この時点で一覧は確実に描画済み。同時に `before` が必ず 1 以上になるため、reload 後のアサーションが「0 のまま 0」で無意味に通る経路が消えます。実行順（このテストの前に AC-3.1 が習慣を作っているかどうか）にも依存しなくなりました。
- `expect(before).toBeGreaterThan(0)` を明示。測定が早すぎた場合はここで即座に落ち、原因が分かる形にしています。
- `page.reload()` の直後に `expectDashboardReady(page)` を挟んでから `toHaveCount(before)`。

あわせて `AC-3.6`（削除後）の `page.reload()` 直後にも `expectDashboardReady` を追加しました。「一覧に無いこと」をロード中の一覧に対して主張していたためで、これも落ちはしないが通っても意味がない側の穴です。

## 3. 同種の箇所の洗い出し（全 spec）

| パターン | 該当 | 対応 |
|---|---|---|
| 自動待機なしの `count()` | `phase3-habits.spec.ts:196` の 1 件のみ（`e2e/` 全体を grep） | 修正済み（2.2） |
| 自動待機なしの `textContent()` / `innerText()` / `.all()` / `isVisible()` | 0 件 | — |
| `page.evaluate()` | `phase2-auth.spec.ts:109`（`document.cookie` を読む）| 一覧・非同期描画に依存しない。HttpOnly の確認であり、ロード状態と無関係なので対応不要 |
| ログイン直後の「不在」アサーション | `phase3-habits.spec.ts:178`（作成前に同名の行が無いこと） | fixture の readiness で実質的に有効化された（従来はロード中に通っていた可能性がある） |
| navigation 直後の最初のアサーションが「不在」 | `phase3-habits.spec.ts` の削除テスト（reload 直後の `toHaveCount(0)`） | `expectDashboardReady` を追加 |
| navigation 直後の最初のアサーションが positive（`toContainText` / `toHaveValue` / `toBeChecked` / `toHaveCount(1)`） | phase1 / phase2 / phase3 の他の reload、phase4 の全 reload | 対応不要。要素の出現を待つので、それ自体がロード完了の待機になっている |
| `not.toBeChecked()` 等、要素の存在を前提とする negative | `phase3-habits.spec.ts:255, 459` | 要素が無ければ失敗して再試行するため、実質的に待機になっている。対応不要 |
| 画面遷移の positive/negative 順序 | `phase2-auth.spec.ts:43-58` は positive を先に置く設計になっている | 既に安全。変更なし |

`--repeat-each` による反復ストレスは行っていません。これらの spec は 1 つの SQLite を共有し、同じ習慣名を再作成すると行が重複して locator が多重一致するため、反復自体が別の失敗を作ります。代わりに **1.2 の遅延注入で「隙間が広がっても結果が変わらない」ことを決定的に確認**しました（旧実装は失敗、新実装は通過）。反復より強い証拠だと考えています。

## 4. 実行結果

`rm -rf .harness/tmp` を毎回挟んだクリーン実行を 3 連続:

| 実行 | 結果 | `e2e-results.json` の stats |
|---|---|---|
| 1 回目 | **43 passed** (51.9s) | `expected: 43, unexpected: 0, flaky: 0` |
| 2 回目 | **43 passed** (51.2s) | `expected: 43, unexpected: 0, flaky: 0` |
| 3 回目 | **43 passed** (51.9s) | `expected: 43, unexpected: 0, flaky: 0` |

- `npx tsc --noEmit`（`e2e/**` を含む）: PASS
- 修正前後で `retries: 0` は不変（`e2e/playwright.config.ts:24`）
- `waitForTimeout` / `setTimeout` / sleep の類は `e2e/` 配下に 1 件も無し（再現用の遅延注入は使い捨て spec 内のみで、削除済み）

## 5. 製品コードについて

**ブロッキング指摘なし。** 「見出しは出ているが一覧はまだ」という状態は、2 本のリクエストを別々に投げる SPA として正常な挙動で、画面には `読み込み中…` が出ています。バグはテスト側の待機条件にありました。

非ブロッキングの所見を 1 つだけ: `client/src/components/Dashboard.tsx` は `useHabits` と `useStats` を独立に走らせるため、初期表示で `今日の習慣` と `統計` が別々のタイミングで埋まります。UI としては妥当ですが、Phase 5 でヒートマップが 3 本目の非同期パネルとして加わると、E2E 側の「決着待ち」条件も 3 つに増えます。`expectDashboardReady` はその増分を 1 か所で吸収できるようにしてあります。

## 6. 変更ファイル

- `e2e/fixtures.ts` — `expectDashboardReady` を追加し、`loginAs` から呼ぶ
- `e2e/specs/phase3-habits.spec.ts` — `AC-3.1 control` の測定点を固定、`AC-3.6` の reload 後に readiness を追加

製品コード（`client/` `server/` `shared/`）には一切触れていません。
