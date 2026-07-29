# Phase 7 review — attempt 1
VERDICT: PASS

## 受け入れ基準

| ID | 判定 | 根拠 |
|----|------|------|
| AC-7.1 | PASS | `server/` 不在・`workspaces: ["client"]`・npm script に `server/` 参照なし = e2e/specs/phase7-local-storage.spec.ts:78。クリーンコピーへの `npm install`（31 packages, 0 vulnerabilities）と `npm run build` を別ディレクトリで実行して確認 |
| AC-7.2 | PASS | `client/dist` は .html/.js/.css のみ・`/api/` 文字列 0 件 = phase7-local-storage.spec.ts:93。**Node を使わない** `python3 -m http.server`（:3102、SPA フォールバックなし）配信で作成・記録・リロード保持まで動作 = phase7-local-storage.spec.ts:121 |
| AC-7.3 | PASS | 作成（2 種）→ 記録（チェック／数値）→ 編集 → 削除 → 取り消し → 削除 → リロードの一連で `/api` へのリクエスト 0 件 = phase7-local-storage.spec.ts:147。記録器が生きていることを `fetch("/api/health")` で反証確認（同 :199） |
| AC-7.4 | PASS | ログイン見出し／ボタン／ログアウト／パスワード欄すべて 0 件、リロード後も同じ = phase7-local-storage.spec.ts:205 |
| AC-7.5 | PASS | `client/src/data/store.test.ts` の往復テストが `await` なしで成立（非同期なら型が通らない）。`npm test` 128 passed。画面側でも「クリック直後に localStorage を読むと入っている」を確認 = phase7-local-storage.spec.ts:224 |
| AC-7.6 | PASS | 壊れ方 6 種（途中で切れた JSON / 非 JSON / `version:99` / 別アプリの JSON / 配列 / habits 行が壊れた v1）+ 空文字列 + 空白のみ。いずれも例外なし（`pageerror` 0 件）、`role="alert"` で説明、**保存バイト列が一字一句そのまま**（追加操作を試みた後・リロード後も）= phase7-local-storage.spec.ts:270 / :306 / :327。対照実験として正常文書が「壊れている」と誤判定されないことも確認（同 :333） |
| AC-7.7 | PASS | Phase 3 の全 spec を localStorage シードに移植して通過 = e2e/specs/phase3-habits.spec.ts。論理削除で `archived_at` が立ち記録が残ること = 同 :315、取り消しで戻ること = 同 :345 |
| AC-7.8 | PASS | Phase 4 の assertion を数値ごとそのまま移植して通過 = e2e/specs/phase4-stats.spec.ts（AC-4.7 / 4.8 / 4.9、および 4.2 / 4.6 の画面側確認） |
| AC-7.9 | PASS | セル数 7×52〜53、記録あり/なしの塗り分け、目標比 6 段階の単調な濃淡（light / dark 両方）、アクセシブルネーム = e2e/specs/phase5-heatmap.spec.ts |
| AC-7.10 | PASS | `browser.newContext()` で `localStorage` が `null`・「習慣がまだ登録されていません。」表示、かつ元コンテキストのデータは残存 = phase7-local-storage.spec.ts:352 |
| AC-7.11 | PASS | 10 習慣 × 1,825 日 = 18,250 件を投入。**初回描画 197ms / 203ms**（2 回計測、Node 側の実時間）。統計・ヒートマップ・5 年前の記録の保持・その状態での記録とリロードまで確認 = phase7-local-storage.spec.ts:386 |
| AC-7.12 | PASS | `Storage.prototype.setItem` を差し替えて `QuotaExceededError` を発生。習慣作成は `role="alert"` で日本語表示＋一覧に出さない（:475）、記録はチェック／**デバウンス経由の数値入力の両方**が行内 `role="alert"` に到達しフォーカスも保持（:500）。`localStorage` 自体が使えない場合も同様 = phase6-polish.spec.ts:111 |
| AC-7.13 | PASS | `git show HEAD:server/src/stats.ts \| diff -u - shared/stats.ts` の差分は **import パス 3 行とコメント 3 箇所のみ**。関数本体に 1 行の変更もない。`stats.test.ts` の差分も import 1 行のみ（26 it、全通過） |
| AC-7.14 | PASS | 375 / 768 / 1280px で主要操作一巡＋横スクロールなし = phase6-polish.spec.ts:193。最大長データ（名前 60 字・単位 12 字・値 1,000,000・削除済み習慣）でも右端はみ出し 0 = 同 :319 |

## ブロッキング指摘

なし。

## 非ブロッキングの所見

1. **`HabitForm.tsx` の `pending` が完全な dead code。** 同期ハンドラ内で `setPending(true)` → `finally { setPending(false) }` と閉じるため、`pending === true` の状態で再描画される瞬間が存在しない。したがって `handleSubmit` 先頭の `if (pending) return`（:61）と `disabled={pending}`（:205, :209）は永久に発火しない。オーケストレーターが受理済みの件だが、残しておくと「二重送信は防いである」と誤読される。次フェーズで削るのが素直。

2. **`store.ts` の `setStorageBackend` / `injected` はテスト用の縫い目で、本番バンドルにも入る。** 実害はない（外部から import できない）が、`document.ts` 側は完全に純関数なので、`store.ts` の薄さを考えると単体テストは `document.ts` に寄せて縫い目を消す選択肢もある。

3. **`Entry.updated_at` の廃止**（受理済み）。実測では 18,250 件の文書が入れ子形式で 275,394 文字（0.26 MB）、行形式（`updated_at` なし）で 824,658 文字（0.79 MB）。`docs/design.md` が挙げる 1.49 MB は `updated_at` 込みの値で、記述と実装は整合している。将来 CRDT 的な同期を足すときは版番号を上げて再導入する前提を、design.md に一行残しておくと良い。

4. **`docs/design.md` 冒頭の Phase 7 注記（指示外の変更）は妥当。** 無効になった節（API / 認証 / データモデル / ディレクトリ構成）を名指しし、「判断とその理由 1〜5 は有効」と明示していて、保存形式の記述も実装と一致している。誤読を招く記述は見つからなかった。

5. **`.gitignore` の `/data/` 修正は正しく効いている。** 新規 6 ファイル（`client/src/data/{document,store}.ts` とその `.test.ts`、`shared/stats.ts` / `stats.test.ts`）がすべて `git status` に `??` で現れ、`git check-ignore` は 1 件もヒットしない。旧 `data/habits.db` は無視されたまま（意図どおり）。

6. **壊れた文書からの画面上の復旧手段が無い件は Phase 8（AC-8.12）へ。** 本フェーズでは要件外。ただし現状、読めない文書の上で「習慣を追加」フォームが操作可能なまま残り、押すたびに「保存を停止しています」と言われる。破壊は起きないので正しいが、AC-8.12 を実装するときはこのフォームの扱いも合わせて考えるべき。

7. **AC-1.7 の扱い（reviewer の解釈）。** 「`/api/health` の結果を画面に描画」は AC-7.3 と正面から矛盾するため、**無効化リストに明記されていないが superseded と判断**した。残った「`/` を開くとページが表示される」だけを `e2e/specs/phase1-scaffold.spec.ts` に残してある。この解釈が誤りなら指摘してほしい。

## E2E の書き直しについて（reviewer 側の変更）

`e2e/` は全面的に書き直した。判定の根拠がここにあるので記録しておく。

- `e2e/playwright.config.ts`: `webServer.url` を `/api/health` → `/` に変更。**サーバーを 2 つ**立てる:
  - `:3101` = `npm run e2e:serve`（`vite preview`）。`vite preview` は `localhost`（::1）にしか bind せず `127.0.0.1` では繋がらないので、`baseURL` は `http://localhost:3101` にしてある。
  - `:3102` = `python3 -m http.server --bind 127.0.0.1 --directory client/dist`。**AC-7.2 を `vite preview` で確認しても意味がない**（SPA フォールバックを持つ）ため、素の静的サーバーを別に立てて、そちらでも動くことを spec で検証している。
  - **CI への影響: `npm run e2e` が `python3` を要求するようになった。** `ubuntu-latest` には入っているので追加ステップは不要だが、前提が増えたことは記録しておく。
- `e2e/global-setup.ts`（新規）: 2 つのサーバーが同じ `client/dist` を配信し `vite build` が `emptyOutDir` するため、**先に 1 回だけビルド**してから両サーバーを起動する。
- `e2e/fixtures.ts`: ログイン導線（`loginAs` / `loggedInPage` / `CREDENTIALS` / `SESSION_COOKIE`）を全削除し、`documentText()` / `byDaysAgo()` / `seedRaw()` / `openDashboard()` に置き換えた。シードは `goto` → `evaluate(setItem)` → `reload`。`addInitScript` は**使っていない**（毎回のナビゲーションで再実行されるため、「リロードしても保持される」系の assertion をすべて無効化してしまう）。時刻固定（`page.clock.install`, 2026-03-15）は従来どおり全 spec に適用。
- `e2e/prepare-db.ts` と `e2e/specs/phase2-auth.spec.ts` を削除（DB と認証が存在しないため）。Phase 3〜6 の spec は assertion をそのまま残して移植した。
- `e2e/specs/phase7-local-storage.spec.ts` を新規追加。

## ネガティブコントロール

移植した assertion が空振りしていないことを、意図的に誤った期待値を入れて確認した（確認後すべて復元済み）。

| 変異 | 結果 |
|---|---|
| AC-4.7 の期待値を `現在ストリーク 5 日` → `6 日` | FAIL（`Received: 統計B_連続5日現在ストリーク 5 日…`） |
| AC-7.3 の `apiRequests(urls)` を `toEqual([])` → `toHaveLength(1)` | FAIL（`Received length: 0`）— 記録器が本当に 0 件を観測している |
| AC-7.6 の保存バイト列期待値に `MUTANT` を付加 | FAIL（`Received: {"version":1,"habits":[{"id":1,"nam`）— `readStorage` が実バイト列を読んでいる |

spec 内に恒久的に残したものとしては、`phase7-local-storage.spec.ts:602` の「シードが本当に画面に届いている」対照、`AC-7.6 control`（正常文書が壊れ扱いされない）、`AC-7.12 control`（正常時にエラーが出ない）、Phase 4 の各 `not.toContainText` がある。
なお最初に書いた `not.toContainText("0 / 30 分")` は `"30 / 30 分"` の部分文字列で**絶対に落ちない対照**だったので、`"15 / 30 分"` に差し替えた。

## 実行結果

- `npm run typecheck`（`tsc --noEmit` ×2、`e2e/**` を含む）: PASS
- `npm test`: **128 passed** / 0 failed（35 suites）
- `npx playwright test`: **85 passed** / 0 failed（1.2 分、chromium、retries 0）
- クリーンコピーでの `npm install` → `npm run build`: 成功（`dist/index.html` + `assets/index-*.js` 219 kB + `assets/index-*.css` 7.25 kB のみ）
- `python3 -m http.server` で `client/dist` を配信 → `GET /` が 200 で index.html を返し、ブラウザから作成・記録・リロード保持まで動作
- `npm run dev` → `http://localhost:5173/` が 200（README の手順どおり）
- AC-7.11 実測: 初回描画 197ms / 203ms（18,250 件、`page.reload()` から習慣 10 行が出るまで）
