# Phase 1 review — attempt 1
VERDICT: PASS

## 受け入れ基準
| ID | 判定 | 根拠 |
|----|------|------|
| AC-1.1 | PASS | `node_modules` を含まないコピーを作り直して `npm install` を実行 → `added 54 packages`、exit 0。workspaces リンク（`node_modules/client -> ../client`, `node_modules/server -> ../server`）と hono / react / vite / concurrently / typescript が解決されていることを `npm ls --depth=0` で確認 |
| AC-1.2 | PASS | クリーンコピーで `npm run dev` を 1 回実行 → `curl :3001/api/health` と `curl :5173/` の双方が成功。concurrently が `[server]`/`[client]` 両方を起動しているログも確認。`:5173/api/health` も proxy 経由で `{"ok":true}` を返す |
| AC-1.3 | PASS | `curl :3001/api/health` → `status=200 content_type=application/json body={"ok":true}`。E2E からも検証: e2e/specs/phase1-scaffold.spec.ts:24。単体: server/src/app.test.ts:10 |
| AC-1.4 | PASS | `DB_PATH=../dbdir/phase1.db PORT=3199 node server/src/index.ts` で起動 → ファイルが生成され、テーブルは `entries,habits,sessions,users` の 4 つ、`user_version=1`。`DB_PATH=data/habits.db`（既定値）でも `data/` ディレクトリごと生成されることを確認（server/src/db.ts:16 の mkdirSync） |
| AC-1.5 | PASS | 同一 DB に対してサーバーを 2 回起動 → 双方ともエラーなく起動し `sqlite_master` の fingerprint SHA が一致（`37fa0b1e…`、rows=8 で不変）。単体テストは 3 回開き直して同値を確認: server/src/migrations.test.ts:63 |
| AC-1.6 | PASS | server/src/db.ts:21 が接続ごとに `PRAGMA foreign_keys = ON` を実行。pragma 値が 1 であることに加え、実際に FK 違反 INSERT が `FOREIGN KEY constraint failed` で弾かれることを単体テストが確認: server/src/migrations.test.ts:45 |
| AC-1.7 | PASS | e2e/specs/phase1-scaffold.spec.ts:32（ページが表示される）、:42（クライアントが `GET /api/health` を実際に発行し、その 200 応答の内容が画面に描画される）、:63（応答を 500 に差し替えると "ok" 表示が消える＝ハードコードでないことの negative control）、:80（リロード後も保持） |
| AC-1.8 | PASS | `npx tsc --noEmit`（ルート）、`npx tsc --noEmit -p server/tsconfig.json`、`npx tsc --noEmit -p client/tsconfig.json` がいずれも exit 0 |

## ブロッキング指摘

なし。

## 非ブロッキングの所見

1. **`e2e/` がどの tsconfig の `include` にも入っていない。** ルート `tsconfig.json:14` は `shared/**`, `server/**`, `client/src/**`, `client/vite.config.ts` のみ。したがって `npx tsc --noEmit` は E2E spec を型検査していない（AC-1.8 は「client / server 双方」なので違反ではない）。spec が増える Phase 3 以降で型エラーが埋もれるので、`e2e/tsconfig.json` を足すか root の include に加えるのが望ましい。今回の spec 単体は `tsc --noEmit`（strict, bundler resolution）で通ることを個別に確認済み。
2. **`.env.example` に `ADMIN_USER` / `ADMIN_PASSWORD` が無い。** Phase 2 で `npm run seed-user` が読む変数で、AC-6.6（`.env.example` に必要な環境変数が全て）に効いてくる。Phase 2 で追記されれば問題なし。
3. **`npm test` の glob が `server/src/**/*.test.ts` 限定**（package.json）。Phase 4 の stats 単体テストが `shared/` に置かれると拾われない。AC-4.1 の前に glob の拡張が要る。
4. `server/src/static.ts:62` は `client/dist` 未ビルド時に 503 とビルド手順を返す。`npm run dev` 中に `:3001/` を直接開いた開発者にはこの文言が出るが、README:25 が :5173 を案内しているので実害なし。挙動としてはむしろ親切。
5. node:sqlite の `DatabaseSync` は既定で FK を有効にするため、`PRAGMA foreign_keys` が 1 であることだけでは db.ts の明示設定の効果を分離できない。単体テストが「制約が実際に効く」ところまで見ているので検証としては十分（指摘ではなく記録）。

## 実行結果
- `npx tsc --noEmit`: PASS（root / server / client の 3 構成すべて exit 0）
- `npm test`: 6 passed / 0 failed（suites 3）
- `npx playwright test`: 5 passed / 0 failed（`.harness/tmp/e2e-results.json`: expected 5, unexpected 0, flaky 0, skipped 0）
- 追加検証（AC-1.1/1.2/1.4/1.5）: node_modules を除いたクリーンコピーでの `npm install` → `npm run dev` → サーバー 2 回起動、いずれも成功
