# Phase 6 review — attempt 1
VERDICT: FAIL

## 受け入れ基準

| ID | 判定 | 根拠 |
|----|------|------|
| AC-6.1 | PASS | e2e/specs/phase6-polish.spec.ts:138, :198。加えてクリーンな複製で `client/dist` を削除 → `node server/src/index.ts` が 503 と手順案内、`npm run build` 後は `/` が 200 text/html、ハッシュ付きアセットが 200 text/javascript、SPA フォールバック 200、存在しないアセット 404 |
| AC-6.2 | PASS | Phase 1〜5 の 55 spec が本番ビルド（`npm run e2e:serve` = build + `node server/src/index.ts`）に対して全て通過（55/55） |
| AC-6.3 | PASS | `node_modules` / `.env` / `data/` / `client/dist` を除いた複製で README の 4 手順を実行 → `npm install` 成功、`cp .env.example .env`、`npm run seed-user` が `data/habits.db` を作成、`npm run dev` で :3210 と :5173 が起動し Vite 経由の `/api/health` も 200。README が挙げる npm script の実在も e2e/specs/phase6-polish.spec.ts:215 で検証 |
| AC-6.4 | PASS | e2e/specs/phase6-polish.spec.ts:282, :298, :332, :344, :371, :387, :425（10 経路）。デバウンスのみで発火する保存失敗も含め、全て `role="alert"` に日本語のメッセージが出る |
| AC-6.5 | **FAIL** | 375px で `document.body` が横に 53px スクロールする。e2e/specs/phase6-polish.spec.ts:560 |
| AC-6.6 | PASS | e2e/specs/phase6-polish.spec.ts:240。コードが読む `PORT` / `DB_PATH` / `COOKIE_SECURE` / `API_PORT` / `ADMIN_USER` / `ADMIN_PASSWORD` が全て `.env.example` に記載され、必須 2 つは代入形式で存在 |

## ブロッキング指摘

1. **AC-6.5**: 375px でヒートマップの習慣セレクタ（`<select id="heatmap-target">`）がビューポート幅を超え、
   ページ本体が横スクロールする。AC-5.5 が明示的に禁じている状態でもある。

   **再現（決定的）**: `e2e/specs/phase6-polish.spec.ts:560`
   「毎朝のストレッチと深呼吸をきちんとやる」（19 文字。`HabitForm.tsx` の `maxLength` は 60）という
   習慣を 1 件作り、375×800 で計測すると:

   ```
   {"body":53,"root":53,
    "wide":["div.","main.app","section.card","div.heatmap__header","div.heatmap__picker"]}
   ```

   セレクタ自体の位置は `x=127, width=301, right=428`（ビューポートは 375）で、右端 53px が画面外。

   **閾値の実測**（習慣名を全角 N 文字にして 375px で `body.scrollWidth - body.clientWidth` を計測）:

   | 名前の長さ | 7 | 9 | 11 | 13 | 15 | 17 |
   |---|---|---|---|---|---|---|
   | 横スクロール量 | 0 | 0 | 0 | 0 | 30px | 53px |

   **Phase 6 が閾値を下げている点**: `HeatmapPanel.tsx` が削除済み習慣を
   `〇〇（削除済み）` として選択肢に残すようになったため、接尾辞 6 文字ぶん短い名前でも起きる。
   9 文字の習慣「あああああああああ」は有効なうちは overflow 0 だが、記録を 1 件残して削除すると
   選択肢が「あああああああああ（削除済み）」になり overflow は 30px になる（実測）。

   **原因箇所**: `client/src/styles.css:460`（`.heatmap__picker select`）。
   `.heatmap__picker` 側には `min-width: 0; max-width: 100%` があり実際に 301px で頭打ちになるが、
   その中の `<select>` は flex アイテムの既定 `min-width: auto` のため min-content 幅
   （= 最も長い option の幅、実測 391px）より縮まず、`overflow: visible` のまま親の箱を
   はみ出す。はみ出したぶんがページのスクロール可能領域を広げている。

   **確認済みの修正方向**（`page.addStyleTag` で注入して計測）:
   `.heatmap__picker select { min-width: 0; flex: 1 1 auto; }` を足すと
   overflow は 53 → 0、セレクタの右端は 428 → 338 になり viewport 内に収まる。
   （文言はそちらの判断で。ここでは原因の特定のために試しただけです）

   **正直に書いておくこと**: これは Phase 6 が作り込んだ不具合ではありません。
   HEAD（Phase 5 時点）を `git archive` して別ポートでビルド・起動し、同じ 19 文字の名前で
   計測したところ、同じ 53px の横スクロールが再現しました（`.heatmap__picker` 系の CSS は
   Phase 6 で未変更）。Phase 5 の spec が短い習慣名しか作らなかったため見逃されていたものです。
   それでも AC-6.5 は「375px でレイアウトが破綻せず」であり、いま満たしていないので FAIL にしています。
   なお、この不具合は私が作為的に長い名前を選んだから出たものではなく、
   **Phase 6 の spec が自分で作った習慣名（`P6_幅1280_散歩（削除済み）` 等）の蓄積だけで
   最初の実行時に踏みました**。

   トレース: `.harness/tmp/test-results/phase6-polish-Phase-6-—-po-67292-lls-sideways-at-every-width-chromium/trace.zip`
   スクリーンショット: 同ディレクトリ `test-failed-1.png`

## builder が判断を仰いだ点への回答

1. **数値式の「目標なし」を作成可能にした件 — 回帰なし。ただし AC 外の仕様拡張として記録する。**
   - AC-3.2（`numeric` + 目標値 + 単位 → 「0 / 30 分」）は回帰していない：
     `phase3-habits.spec.ts` の該当テストに加え、`phase6-polish.spec.ts:733` で
     作成直後とリロード後の両方で「0 / 30 分」を確認。
   - 目標なしのときの表示も破綻していない（`phase6-polish.spec.ts:750`）：
     行は `0 ページ` と出て `/` を含まない（`0 /  ページ` のような欠けた表示にならない）、
     バッジは未達成、値 3 を入れると達成に変わりリロード後も保持、
     統計は現在ストリーク 1 日、ヒートマップのセルは `2026-03-15 3 ページ 達成`。
     塗り・ラベル・統計・行バッジの 4 者が `isAchieved()` で一致している。
   - **所見**: これは AC に無い仕様拡張であり、Phase 3 で builder 自身が書いた単体テスト
     「rejects a numeric habit without a target」の意図を反転させている。
     `docs/design.md` §2 の記述を根拠とする解釈は筋が通っており、実害も観測されなかったので
     ブロッキングにはしない。ただし「AC に書かれていない仕様を、過去フェーズのテストを
     書き換えて導入した」ことは記録に残す。
2. **`POST /api/habits/:id/restore` と「削除を取り消す」— 問題なし。**
   - AC-3.6 は回帰していない：`phase3-habits.spec.ts` の AC-3.6 テストが通り、
     `phase6-polish.spec.ts:788` でも「1 クリックで一覧から消える（ダイアログを挟まない）」→
     「取り消しで戻り、3 日前の記録も残っている」を確認。
   - 存在の漏洩なし：`phase6-polish.spec.ts:813` で
     「自分の削除していない習慣」「他人の削除済み習慣」「存在しない id」の 3 つが
     いずれも 404 で、**本文がバイト単位で同一**であることを確認。
     他人の習慣の `archived_at` も NULL に戻っていない。
3. **複数の `role="alert"` — 同意。spec 側の書き方の問題として扱った。**
   `alertWith(page, text)` = `getByRole("alert").filter({ hasText })` で名指ししている。
   パネルごとにエラーを出すこと自体は AC-6.4 に適合しており、指摘しない。
4. **ログアウト失敗時に画面に留まる件 — 問題なし。**
   失敗時にエラーが出てダッシュボードに留まること（`:425`）と、
   成功時に AC-2.8 が回帰していないこと（`:470`：ログイン画面に戻り、リロードしても戻らない）を両方確認。
5. **`include_archived=1` のスコープ — 漏洩なし。**
   `phase6-polish.spec.ts:844` で他ユーザーの有効／削除済み習慣を DB に直接仕込み、
   `GET /api/habits?include_archived=1` の応答にも、ヒートマップの選択肢
   （`getByRole("option")`）にも現れないことを確認。
6. **`COOKIE_SECURE` — `.env.example` と README の両方に記載あり。** AC-6.6 は満たしている。
7. **60 秒の追随遅延 — 許容。** AC には日跨ぎの要件が無い。実測は下記。
8. **375px で「追加」が縦方向に初期ビューポート外 — ブロッキングにしない。**
   AC-6.5 の文言は「到達可能」であって「初期表示内」ではない。
   `phase6-polish.spec.ts:487` で 375px のまま
   習慣名入力 → 追加 → チェック → 編集 → ヒートマップ切替 → 削除 → 取り消し → ログアウトまで
   実際に操作できることを確認した（通常のスクロールのみ）。
   **横方向は別問題**で、そちらが上記のブロッキング指摘。

## 追加で確認したこと（いずれも合格）

- **Cookie の `Secure` 判定 — 実 HTTP で確認。**
  ローカルにサーバーを起動し `curl` で `Set-Cookie` を直接観測:

  | 条件 | `Secure` |
  |---|---|
  | http、ヘッダなし | 付かない |
  | `X-Forwarded-Proto: https` | 付く |
  | `X-Forwarded-Proto: https, http`（先頭 https） | 付く |
  | `X-Forwarded-Proto: http, https`（先頭 http） | 付かない |
  | `X-Forwarded-Proto: HTTPS`（大文字） | 付く |
  | `X-Forwarded-Proto: bogus` | 付かない（URL のスキームにフォールバック） |
  | `COOKIE_SECURE=true` + http | 付く |
  | `COOKIE_SECURE=false` + `X-Forwarded-Proto: https` | 付かない |
  | `COOKIE_SECURE=nonsense` | 起動時に exit 1（黙って既定値に落ちない） |

  ブラウザ側からも `phase6-polish.spec.ts:680, :700` で同じことを確認
  （E2E は http なので `Secure` が付かないこと、`X-Forwarded-Proto` を足すと付くこと）。

- **`useToday` の日跨ぎ追随と無限フェッチの不在** — `phase6-polish.spec.ts:629`。
  `page.clock.fastForward("24:00:00")` で 2026-03-15 → 03-16 に跨ぐと、
  今日パネルの日付・統計の「時点」・ヒートマップのアクセシブルネームの右端が全て 03-16 になり、
  03-16 のセルが 1 個存在する。この間に 60 秒間隔のタイマーは 1440 回発火するが、
  跨いだ後の `GET /api/stats` は 1 回（≤3 で判定）、`GET /api/habits` も同様。
  さらに同じ日のまま 10 分進めても追加リクエストは発生しない。
  `heatmapStart` の `useMemo` 化は効いている。

- **ネガティブコントロール** — 以下 4 つをわざと誤った期待値に書き換えて実行し、
  4 つとも落ちることを確認してから元に戻した（assertion が空振りしていないことの確認）:
  1. デバウンス保存失敗のメッセージを「絶対に出ない文字列」に → 落ちる
  2. `.env.example` に無い変数名を検査対象に追加 → 落ちる
  3. http なのに `Secure` が付くと主張 → 落ちる
  4. 日跨ぎ後も統計が前日のままと主張 → 落ちる

## 非ブロッキングの所見

1. `parseOptionalTarget` は `target: ""`（空文字）も「目標なし」として受理する。
   JSON クライアントが空文字を送るのは基本的にバグなので、400 で弾くほうが親切かもしれない。
   実害は無い。
2. 削除通知（`undo`）は意図的に live region ではないと明記されている。設計判断として妥当だが、
   スクリーンリーダー利用者には「削除された」ことが読み上げられない。
   `role="status"` にすると読み上げが煩いというトレードオフも理解できるので、現状で構わない。
3. `describeError` は `ApiError` 以外の `Error` を `${fallback}（${cause.message}）` にする。
   `api.ts` が全て `ApiError` に変換しているので実際にはほぼ通らない経路だが、
   万一通ると英語の例外メッセージが括弧内に出る。現状の実装では観測されなかった。
4. AC-6.5 の 375px で「追加」ボタンが初期ビューポート外にある件（builder 申告 8）は
   上記のとおりブロッキングにしていないが、フォームがページ最下部にあるのは
   モバイルでは操作回数が増える。v1 の範囲外として記録だけしておく。

## 実行結果

- `npx tsc --noEmit`: PASS（`npm run typecheck` = root / server / client の 3 つとも PASS）
- `npm test`: 172 passed / 0 failed（44 suites）
- `npx playwright test`: 78 passed / 1 failed（expected 78, unexpected 1, flaky 0, skipped 0）
  - Phase 1〜5: 55 passed / 0 failed
  - Phase 6: 23 passed / 1 failed（失敗は AC-6.5 の 375px 横スクロール 1 件のみ）
- 手動確認: クリーン複製からの `npm install` → `.env` → `seed-user` → `npm run dev`（AC-6.3）、
  `client/dist` 削除 → 503 → `npm run build` → `node server/src/index.ts` 単体配信（AC-6.1）、
  `curl` による `Set-Cookie` の `Secure` 判定 8 パターン
