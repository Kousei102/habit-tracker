# Phase 8 review — attempt 1
VERDICT: PASS

## 受け入れ基準

| ID | 判定 | 根拠 |
|----|------|------|
| AC-8.1 | PASS | `dist/manifest.webmanifest` が生成され `index.html` から `<link rel="manifest">`。name / short_name / start_url / display=standalone / theme_color / background_color を確認、192・512 の PNG は IHDR を spec 側で独自に復号して実寸を確認 — e2e/specs/phase8-pwa-backup.spec.ts:225, :274 |
| AC-8.2 | PASS | ビルド後 HTML に `apple-mobile-web-app-capable=yes` と `<link rel="apple-touch-icon" href="./apple-touch-icon.png">`、実体は 180x180 の正方 PNG — e2e/specs/phase8-pwa-backup.spec.ts:287。**実機 iPhone では未検証（環境制約）** |
| AC-8.3 | PASS | `data-sw="controlled"` を待ってから `context.setOffline(true)` → reload。起動・習慣作成・記録・再リロード後の保持まで確認。`vite preview`（`Vary: Origin` を返す）と `python3 -m http.server`（Vary なし）の両方 — spec:328, :373。負の対照 2 本あり（下記） |
| AC-8.4 | PASS | `persisted()` を false に固定したうえで `persist()` の呼び出しを実測。`persist()` が reject する状況でもダッシュボードは動作し、`storage-persistence` が「永続化されていません」と表示 — spec:672, :693 |
| AC-8.5 | PASS | `habit-tracker-2026-03-15.json` がダウンロードされ、**削除済み習慣（archived_at 付き）とその 2 日分の記録**、および値 0 の記録まで含むことをファイル内容で確認 — spec:719 |
| AC-8.6 | PASS | エクスポート → **画面から初期化** → インポートで、習慣・今日の値・現在/最長ストリーク・30 日達成率・ヒートマップ 365 セルの aria-label 全一致・削除済み習慣とその記録が復元。復元後の保存文書が復元前と完全一致 — spec:794, :857 |
| AC-8.7 | PASS | ファイル選択時点では要約（習慣 3 / 記録 4 / 期間）のみで localStorage は 2 キーとも不変、「インポートを実行」で初めて反映。`page.on("dialog")` を張り、ネイティブダイアログが 1 度も出ないことを確認 — spec:882 |
| AC-8.8 | PASS | 11 種の不正ファイルすべてで localStorage が**バイト単位で不変**、読めるエラー、確定ボタン自体が出現しない、リロード後も不変 — spec:1040。対照として正常ファイルではバイトが変わることを確認 — spec:1084 |
| AC-8.9 | PASS | 未実施時は「まだ一度もエクスポートしていません」、実行後は `2026-03-15`、リロード後も保持。40 日前を仕込むとその日付が出て今日の日付は出ない（「常に今日を出しているだけ」ではないことの対照） — spec:754, :776 |
| AC-8.10 | PASS | README に「7 日間操作しないと localStorage を削除」＝記録が全部消える旨、Safari の共有ボタンからの追加手順 5 ステップ、Safari 側とホーム画面側でデータ置き場が別である注意、エクスポート併用の必要性 — README.md、spec:311 |
| AC-8.11 | PASS | 375px でカード・エクスポート・ファイル選択・要約・確定・初期化 UI がすべて viewport 幅内、body/documentElement の横スクロールなし。その幅でエクスポートとインポートを実行 — spec:1261, :1299 |
| AC-8.12 | PASS | 壊れた文書で (a) インポート (b) 初期化 (c) 生バイト救出 のすべてに画面から到達。復旧 UI の表示・生バイト書き出し・初期化パネルを開く・チェックを入れる、のいずれでも保存バイトは不変。初期化は「開く → チェック → 実行」の 3 アクションで、開いた直後は disabled — spec:1136, :1161, :1172, :1194, :1230 |

## ブロッキング指摘

なし。

## 負の対照（このスイートが本当に検出できることの確認）

指摘が出せなかった以上、「テストが空振りしていないこと」の証拠を残します。

1. **`ignoreVary` は載っている**（最重要の検証依頼）。spec 内で `client/dist` を配信する HTTP サーバーを起動し、`Vary: Origin` を返す構成で 2 通り試しました。
   - そのままの `sw.js`: オフラインでダッシュボードが描画される（spec:518）
   - `sw.js` の `ignoreVary: true` → `false` に置換したものを配信: オフラインでダッシュボードが**出ない**（spec:542）。置換が実際に起きたことを `expect(patched).toBe(true)` で確認しているので、将来 `ignoreVary` の記述が消えたらこの対照は「空振り」ではなく失敗します
   - 実測したヘッダ: `vite preview` → `Vary: Origin` あり / `python3 -m http.server` → `Vary` なし（`content-type: application/manifest+json` も正しい）。E2E は両方のホストで通っています
2. **Service Worker が無ければオフラインは本当に失敗する**（spec:401）。登録解除＋`caches` 全削除の後にオフラインで開くとダッシュボードは出ません。これが無いと「オフラインで動く」は HTTP キャッシュでも通ってしまいます
3. **AC-8.8 のバイト比較は失敗しうる**（spec:1084）。正常ファイルのインポートでは `localStorage` のバイトが確かに変わります
4. **アイコンのピクセル比較は空振りしていない**。`scripts/` と `client/public/` を書き込み可能な場所へ複製し、プロジェクト自身のエンコーダで `icons/icon-192.png` の 1 ピクセル 1 チャンネルだけを反転して（構造的には正しい PNG のまま）再エンコードしたところ、`icons/icon-192.png is what scripts/icons.ts draws` が `not ok` になりました。複製直後は 10 件すべて pass
5. **AC-8.9 は「今日を出しているだけ」ではない**（spec:776）、**AC-8.12 は「常に壊れている扱い」ではない**（spec:1249）

## Service Worker の更新経路（AC ではないが依頼事項・実測）

`client/` と `shared/` と `tsconfig.base.json` を `.harness/tmp` に複製し、`styles.css` に `.card__title { color: rgb(1,2,3) }` を足して**本物の `vite build` をもう一度**回し、同一オリジンで配信ディレクトリを差し替えて実測しました（spec:583）。

- 更新前のキャッシュは 1 個（`habit-tracker-61eb36d8d641`）
- 差し替え後に reload すると見出しの色が新ビルドの `rgb(1, 2, 3)` になる = **新しいアプリが届く**
- その後キャッシュは 1 個だけになり、**古いキャッシュ名は消えている**（install 直後は 2 個併存するので settle まで poll）
- 新ビルドでオフラインにしても新しい色のまま起動する

「古いキャッシュが新しいアプリを永久に配信し続ける」事故は、少なくともこの経路では起きません。

## 非ブロッキングの所見

1. **ビルド失敗時に本当の原因が隠れる。** `client/vite.config.ts` の `serviceWorker` プラグインは `closeBundle` で `walk(dist)` を無条件に実行します。ビルドが前段で失敗すると `dist` が存在せず、出力は
   `Error: ENOENT: no such file or directory, scandir '<root>/dist' … plugin: 'habit-tracker-service-worker', hook: 'closeBundle'`
   だけになります。実際、複製したソースツリーで `tsconfig.base.json` が無い状態のビルドは真因が `Tsconfig not found` でしたが、プラグインを外すまで一切表示されませんでした。`if (!fs.existsSync(dist)) return;` を 1 行入れるだけで、将来のビルド失敗のデバッグ時間が変わります。（今回の再現は reviewer 側の複製環境で起きたもので、製品のビルドは正常です）
2. **判断 1（壊れた状態でエクスポートを disabled）は AC 違反ではない。** AC-8.5 は「エクスポートすると JSON がダウンロードされる」であって、解析不能な文書からの構造化エクスポートは要求していません。代替として生バイト救出が用意され、README にも手順があるので、この設計を支持します
3. **判断 2（孤児レコードを保持）に同意。** 復元でレコードを落とすほうが害が大きいので妥当です。挙動が偶然でないことを spec:1100 で固定しました（将来これを捨てる変更は明示的な判断として行われるべき）
4. **判断 3・5・6 は AC に無く、いずれも妥当。** 重複 `(habit_id,date)` の後勝ち、催促 30 日、更新バナー無し（更新は次回起動で届くことを上記で実測済み）
5. **判断 4（初期化しても `habit-tracker.last-export` を残す）についてひとつだけ。** コード上 `resetAll()` は文書キーしか書かないので確かに残ります。ただし他人のファイルをインポートした直後や端末を譲渡した後は「最後にエクスポートした日」が別のデータセットの事実になります。害は小さいので v1 のままで構いません
6. **512px と maskable アイコンはプリキャッシュ対象外。** 初回インストールがオフラインで、かつ OS がその時点でアイコンを取りに来る場合だけ取り逃しますが、実害はほぼありません
7. `sw.js` の `message` ハンドラ（`skip-waiting`）は現状どこからも送られていません。将来の更新バナー用の足場として残っているだけです

## 実行結果

- `npx tsc --noEmit`（ルート、e2e/ 込み）: PASS
- `npm run typecheck`（ルート + client）: PASS
- `npm test`: **221 passed / 0 failed**（48 suites）
- `npx playwright test`: **125 passed / 0 failed**（既存 85 + 新規 40、2.1 分）。既存 6 spec の回帰なし
- 追加検証: アイコンのピクセル比較の負の対照（複製環境）、`vite preview` / `python3 -m http.server` のヘッダ実測、2 回目の実ビルドによる SW 更新経路
