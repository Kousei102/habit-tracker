# Phase 1 FAIL 経路の検証
VERDICT: FAIL

（この `VERDICT: FAIL` は「仕込まれたバグを spec が検出した」ことを表します。attempt 1 の PASS 判定とは別扱いのファイルです。spec は attempt 1 から 1 文字も変更していません。）

## 結論

**検出できた。** `npx playwright test` は 4 passed / 1 failed。

## 落ちたアサーション

| 項目 | 内容 |
|------|------|
| spec | `e2e/specs/phase1-scaffold.spec.ts:63` — "AC-1.7: what is rendered is derived from the response, not hardcoded" |
| 落ちた行 | `e2e/specs/phase1-scaffold.spec.ts:73` |
| アサーション | `await expect(page.getByText(/{\s*"?ok"?\s*:\s*true\s*}/)).toHaveCount(0)` |
| 結果 | `Expected: 0 / Received: 1`（5 秒間リトライして 14 回とも 1 要素） |
| トレース | `.harness/tmp/test-results/phase1-scaffold-Phase-1-—--30d19--the-response-not-hardcoded-chromium/trace.zip` |
| スクリーンショット | 同ディレクトリ `test-failed-1.png` / `video.webm` / `error-context.md` |

再現手順は spec がそのまま持っている: `page.route("/api/health")` で **HTTP 500 + `{"error":"boom"}`** を返すようにしてから `/` を開く。

## トレースから読み取れる事実

`error-context.md` のページスナップショット（`/api/health` が 500 を返している状態）:

```yaml
- main:
  - heading "習慣トラッカー" [level=1]
  - region:
    - heading "サーバー接続" [level=2]
    - status: "API 接続: ok"
    - generic: "{\"ok\":true}"
```

API が 500 を返しているにもかかわらず、画面は `API 接続: ok` と、サーバーが一度も送っていない `{"ok":true}` を表示している。行 73 で止まったため実行されていないが、後続の行 77（`not.toHaveText(/(^|[^n])ok\s*$/i)`）も同じ理由で落ちる状態にある。

## バグの内容（コードで特定）

`client/src/App.tsx:20-22`。`getHealth()` の rejection ハンドラが、エラーを捨てて成功状態を捏造している。

```diff
-      .catch((error: unknown) => {
-        if (cancelled) return;
-        const message = error instanceof Error ? error.message : String(error);
-        setHealth({ status: "error", message });
+      .catch(() => {
+        if (!cancelled) setHealth({ status: "ok", data: { ok: true } });
       });
```

`client/src/api.ts:28` が `!response.ok` で投げた `ApiError` がここで握り潰され、`HealthState` が `{ status: "ok", data: { ok: true } }` に上書きされる。結果、`HealthLine`（`App.tsx:62-70`）が実際のレスポンスと無関係に `API 接続: ok` と生 JSON `{"ok":true}` を描画する。

影響: **AC-1.7 の「クライアントが取得した `/api/health` の結果が画面に描画される」を満たさない**（描画されているのは取得結果ではなく定数）。加えて AC-6.4「API がエラーを返したとき、画面にユーザーが読めるエラー表示が出る（無言で失敗しない）」の直接的な違反でもある。サーバーが落ちていても画面は「ok」と言い続ける。

## 他の検査は素通りした（重要）

| 検査 | 結果 | 備考 |
|------|------|------|
| `npx tsc --noEmit` | PASS (exit 0) | `{ ok: true }` は `HealthResponse` として型的に正当なので、静的検査では捕まらない |
| `npm test` | 6 passed / 0 failed | サーバー側単体テストなので client の描画は範囲外 |
| E2E テスト 1（AC-1.3 API 直叩き） | PASS | サーバーは正常。バグは client 側 |
| E2E テスト 2（ページ描画） | PASS | 見た目は正常 |
| E2E テスト 3（health を fetch して描画） | PASS | ハッピーパスは無傷なので当然通る |
| E2E テスト 5（リロード後も保持） | PASS | 同上 |
| **E2E テスト 4（negative control）** | **FAIL** | ここだけが検出した |

つまりこのバグを捕まえたのは、**「API を異常系に差し替えて、画面が成功を主張しないことを確かめる」1 本の negative control だけ**です。ハッピーパスのアサーションをいくら厚くしても、この種の「失敗を握り潰して成功に見せる」バグは 1 つも検出できません（実際 4 本とも通っている）。

Phase 2 以降でも同じ構造を維持します: ログイン失敗・401・保存失敗などの異常系を必ず 1 本入れ、「エラー時に成功表示が出ないこと」を assert します。

## 実行結果
- `npx playwright test`: 4 passed / 1 failed
- `npx tsc --noEmit`: PASS
- `npm test`: 6 passed / 0 failed

## 補足
- spec には一切手を入れていません（attempt 1 と同一）。
- `client/src/App.tsx` の修正は行っていません。オーケストレーターの revert 待ちです。
