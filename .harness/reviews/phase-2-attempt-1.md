# Phase 2 review — attempt 1
VERDICT: PASS

AC-2.1〜AC-2.8 を全て検証し、全て満たしていることを確認しました。E2E 18 本（Phase 1 の 5 本を含む）が
**空の DB からの初回実行で** 全て通ります。

## 受け入れ基準

| ID | 判定 | 根拠 |
|----|------|------|
| AC-2.1 | PASS | `npm run seed-user` を新規 DB に実行 → `users` 1 行作成。同じ `ADMIN_USER` で再実行 → 行数 1 のまま（id=1 のまま）、旧パスワードは `verifyPassword` false、新パスワードは true。`ADMIN_USER=` 空なら exit 1 + 説明メッセージ。`server/scripts/seed-user.ts:30-46` |
| AC-2.2 | PASS | 実サーバーへ Cookie 無しで `GET /api/habits` → 401 / `application/json`。偽トークン付きでも 401。e2e/specs/phase2-auth.spec.ts:61, :72、単体 server/src/routes/auth.test.ts:112-141 |
| AC-2.3 | PASS | 実ブラウザで取得した `set-cookie` が `session=<64hex>; Path=/; Expires=...; HttpOnly; Secure; SameSite=Lax`。Playwright の cookie jar でも `httpOnly=true` / `sameSite=Lax`、`document.cookie` からは不可視。e2e/specs/phase2-auth.spec.ts:80 |
| AC-2.4 | PASS | 誤パスワードと未知ユーザーが **バイト単位で同一** の 401 本文（`Content-Length: 78` も一致）。ユーザー名を含まず、Set-Cookie も出ない。画面側も同一文言の `role="alert"` のみ。e2e/specs/phase2-auth.spec.ts:118, :146 |
| AC-2.5 | PASS | seed 後の `users.password_hash` は `<32hex>:<128hex>`。DB ファイルを生バイト走査しても平文（ASCII / UTF-8 日本語の両方で試行）は不在。`server/src/auth.ts:25-29` |
| AC-2.6 | PASS | 未認証で `/` → ログイン見出し・ユーザー名・パスワード・ログインボタンが可視、ダッシュボード見出しとログアウトボタンは 0 件。e2e/specs/phase2-auth.spec.ts:167 |
| AC-2.7 | PASS | ログイン → ダッシュボード表示。リロード時に `GET /api/auth/me` が 200 を返し、ダッシュボードのまま。2 回目のリロードでも維持。e2e/specs/phase2-auth.spec.ts:184, :220 |
| AC-2.8 | PASS | ログアウト → ログイン画面。リロード後・再 goto 後もダッシュボードは 0 件、Cookie も空。旧トークンを直接送っても `/api/auth/me` `/api/habits` とも 401（サーバー側で無効化されている）。e2e/specs/phase2-auth.spec.ts:228, :247 |

## ブロッキング指摘

なし。

## negative control（このゲートが機能していることの実証）

Phase 1 と同じ手続きで、**捏造バグを注入したときに spec が落ちることを実際に確認**しました。
`e2e/specs/_negative-control.spec.ts` に本番 spec と同じアサーションを持つコピーを一時的に置き、
`page.route()` でサーバー応答を差し替えて実行し、確認後に削除しています（製品コードは一切変更していません）。

| 捏造バグ | 内容 | 結果 |
|----------|------|------|
| NC-A | `POST /api/auth/login` がどんなパスワードでも 200 + Cookie を返す | **FAIL（検出）** `getByRole("alert")` が現れず、ダッシュボードに遷移した |
| NC-B | 偽トークンに対して `GET /api/auth/me` が 200 を返す | **FAIL（検出）** リロード後にログイン画面ではなくダッシュボードが出た |
| NC-C | ログアウト後も `GET /api/auth/me` が 200 を返す | **FAIL（検出）** リロードでダッシュボードが復活した |

3 本とも「成功表示が出ないこと」を見る異常系アサーションで落ちています。ハッピーパスのアサーション
（AC-2.7 の一群）は NC-A〜C のいずれでも素通りしました。異常系が無ければこのフェーズは
「誰でもログインできる」実装でも PASS になります。

## E2E ハーネス側の不具合（reviewer 起因。修正済み・builder の対応不要）

**最初の全体実行は 7 failed でした。原因は製品コードではなく、Phase 1 で私が書いた
`e2e/global-setup.ts` の実行順序にあります。**

- 事実: Playwright は `webServer` を `globalSetup` **より先に** 起動する。実測ログでも
  `[server] listening` が `[seed-user] created user` より先に出る。
- 結果: サーバーが `.harness/tmp/e2e.db` を作成して開いた **後** に globalSetup が同ファイルを
  `fs.rmSync` で unlink し、seed-user が別 inode の新しいファイルを作っていた。SQLite は unlink 済み
  inode をそのまま使い続けるため、サーバーからは seed したユーザーが永久に見えない。
- 観測: 全ログイン成功後に seed 済み `.harness/tmp/e2e.db` を開くと `sessions: 0`（サーバーは
  別の実体に書いていた）。DB を消して実行すると 7 failed、残したまま再実行すると 18 passed
  ——つまり **通っていたのは前回実行の残骸 DB のおかげ** で、globalSetup が防ぐつもりだった状態そのものでした。
- 修正: `e2e/global-setup.ts` を削除し、`e2e/prepare-db.ts` を `webServer.command` の第 1 段
  （`node e2e/prepare-db.ts && npm run e2e:serve`）に移動。サーバーが開く前に必ず wipe+seed が完了します。
  修正後、`.harness/tmp/e2e.db` を削除した状態から 18 passed、実行後の `sessions` も 5 行入っており、
  サーバーが seed 済みファイル本体に書いていることを確認しました。

builder の申し送り 1〜5 は全て実測で確認済みです（Secure 付与、logout 200、400/401 の切り分け、
`role="status"` は 1 個、`/api/habits` は `[]`）。

## 非ブロッキングの所見

1. **`Secure` が localhost の特例に依存している。** E2E は `NODE_ENV=production` なので
   `Secure` 付きの Cookie が `http://localhost:3101` に発行されます。Chromium が localhost を
   secure context 扱いするため今は動きますが、`e2e/playwright.config.ts` の `BASE_URL` を
   localhost 以外（LAN IP や docker のホスト名）に変えた瞬間、Cookie が保存されず Phase 2 以降の
   E2E が全滅します。原因が分かりにくい壊れ方なので、`server/src/auth.ts:131` に localhost 例外を
   入れるか、E2E の `NODE_ENV` を production 以外にするかを Phase 6 までに検討する価値があります。
   （AC には無いので今回は指摘のみ）
2. `POST /api/auth/login` を既ログイン状態で呼ぶと `sessions` に行が増え続け、古いトークンも有効なままです。
   単一ユーザー運用なので実害は小さく、`deleteExpiredSessions` で最終的に回収されます。
3. `LoginPage.tsx` は空欄送信を HTML の `required` に任せています。サーバーも 400 を返すので破綻はしません。
4. `Dashboard.tsx` の `getHabits()` は Phase 3 で形が変わる前提の `unknown[]` です。想定どおり。

## Phase 3 以降への申し送り（E2E 側）

`e2e/fixtures.ts` にログイン導線をまとめました。Phase 3 以降の spec はログイン手順を再実装しないでください。

- `test` fixture `loggedInPage` … 時刻固定済み・ログイン済みでダッシュボードにいる `Page`
- `loginAs(page, credentials?)` / `submitLogin(page, credentials?)` … 明示的にログインしたい場合
- `CREDENTIALS`, `SESSION_COOKIE`, `FIXED_NOW`, `TODAY`, `daysAgo(n)`
- ロケータ: `loginHeading` / `usernameField` / `passwordField` / `loginButton` / `loginError` /
  `dashboardHeading` / `logoutButton`（全て role + アクセシブルネーム経由）

時刻は全 spec で `FIXED_NOW = 2026-03-15T09:00:00` に固定済み。過去データは `daysAgo(n)` で相対指定してください。

## 実行結果

- `npx tsc --noEmit`: PASS（exit 0。`e2e/**` も型検査対象）
- `npm run typecheck`（root + server + client）: PASS
- `npm test`: 28 passed / 0 failed（9 suites）
- `npx playwright test`: **18 passed / 0 failed**（DB を削除した clean state から。Phase 1 の 5 本を含む）
- negative control（一時 spec、確認後削除）: 3 failed / 0 passed = 期待どおり全て検出
