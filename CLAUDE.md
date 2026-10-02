# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## このプロジェクトは何か

個人用の習慣トラッカー。**サーバー・API・認証・DB は存在しません。** ブラウザだけで動く
静的サイト（React + Vite）で、データは `localStorage` のキー `habit-tracker` に JSON 1 件
として保存されます。GitHub Pages に無料でホストされ、iPhone の PWA として使うことが
想定端末です。

この構成は Phase 7 で意図的に到達したものです（それ以前は Hono + SQLite + 認証でした）。
**「サーバーに送る」「API を叩く」形の実装は設計違反です。**

ドキュメントの役割分担:

| ファイル | 役割 |
|---|---|
| `docs/phases.md` | **唯一の正典。** フェーズ定義と受け入れ基準（AC-N.M） |
| `docs/design.md` | 「なぜそう作るか」。実装で迷ったときの判断基準 |
| `README.md` | 利用者向け。ホーム画面追加手順、バックアップ、デプロイ設定 |

## コマンド

```bash
npm install               # Playwright のブラウザは入らない
npm run dev               # http://localhost:5173（Service Worker は登録しない）

npm run typecheck         # ルート（e2e 含む）+ client の 2 パス
npm test                  # node:test 単体テスト
npm run e2e               # Playwright E2E（本番ビルドに対して実行）

npm run build             # client/dist に静的ファイル一式
npm run preview           # dist をそのまま配信（http://localhost:4173）
npm run icons             # アイコン PNG を再生成（出力はコミット済み。通常不要）
```

Node 22.18+ が必須です（`.ts` を型ストリッピングで直接実行するため）。

### 単体テストを絞って走らせる

```bash
node --disable-warning=ExperimentalWarning --test shared/stats.test.ts
node --disable-warning=ExperimentalWarning --test --test-name-pattern="streak" shared/stats.test.ts
```

### E2E を絞って走らせる

初回のみ `npx playwright install chromium` が必要です。

```bash
npm run e2e -- e2e/specs/phase8-pwa-backup.spec.ts
npm run e2e -- -g "AC-5.1"      # test 名は "AC-N.M: …" 形式なので AC 単位で絞れる
npm run e2e:report              # 失敗時のトレース / スクリーンショット
npm run harness:smoke           # アプリコード抜きで Chromium が起動するかだけ確認
```

E2E は `globalSetup` でビルドし、**2 つのサーバー**に対して走ります。3101 は
`vite preview`（SPA フォールバックあり）、3102 は `python3 -m http.server`（フォールバック
なしの素の静的配信）。後者は「任意の静的ホストで動く」（AC-7.2）を証明するためのもので、
フォールバックに暗黙依存した実装をここで落とします。

## アーキテクチャ

### 層と、その境界の意味

```
shared/            純関数のドメイン層。時計もストレージも DOM も触らない
  domain.ts          isAchieved() / isISODate() / toISODate() / addDays()
  stats.ts           ストリークと達成率
  heatmap.ts         格子・濃淡・アクセシブルネーム
client/src/
  data/document.ts   保存文書の形式・版管理・全 CRUD ルール（すべて純関数）
  data/backup.ts     エクスポート形式とインポート検証（すべて純関数）
  data/reminder.ts   未達成の集計と画面に出す文（すべて純関数）
  data/store.ts      ★ localStorage に触る唯一のファイル
  pwa.ts             SW 登録 / storage.persist() / アイコンのバッジ（すべて fail soft）
  hooks/             store を呼び、コンポーネントに同期的な API を渡す
  components/        表示のみ
  errors.ts          画面に出す日本語メッセージ（DataError）
```

この分割の目的は**ブラウザ抜きでテストできる範囲を最大化すること**です。判断は全部
`document.ts` / `backup.ts` / `shared/` の純関数側にあり、`store.ts` は「文字列を読む・
書く・失敗を人間の文に変える」だけです。ロジックを `store.ts` やコンポーネントに書き足す
と、その分だけ `node:test` の射程から外れます。

### 破ってはいけない不変条件

1. **達成判定は `shared/domain.ts` の `isAchieved()` 一箇所だけ。**
   `value >= target` 相当の比較を他の場所に書かないこと。二重化すると「画面は達成なのに
   ストリークが伸びない」形でズレます。**未達成の集計（リマインダーとバッジ）も同じ関数を
   経由します** — 「今日の記録があるか」で代用しないこと（目標の途中が達成扱いになります）。
2. **「今日」を読むのは `client/src/hooks/useToday.ts` だけ。**
   それ以外は `YYYY-MM-DD` 文字列として引数で受け取ります。`new Date()` から日付を導出
   する実装を足さないこと（TZ 依存とテスト不能を同時に持ち込みます）。日付演算は
   `addDays()` を使う（UTC で計算するため DST で壊れない）。
3. **現在ストリークは今日が未達成でも途切れさせない。** today 未達成なら昨日から遡る。
4. **習慣の削除は論理削除**（`archived_at` をセット）。`entries` は消しません。過去の
   ヒートマップに穴が空くのと、エクスポートに含められなくなるのを避けるためです。
   削除済み習慣もヒートマップのセレクタに「〇〇（削除済み）」として並びます。
5. **ストレージ層は同期のまま。** `localStorage` は同期 API なので、書き込みは
   Promise ではなく保存された値を返します。`async` にすると全コンポーネントに無意味な
   ローディング状態が生えます。
6. **読めないデータを黙って上書きしない。** 文書に `version` が入っていて、未知の版・
   壊れた JSON に出会ったら**読み込みを失敗させ、書き込みを止め**、画面にエラーを出します。
   この状態でも「バックアップ」カードから復旧・初期化に到達できる必要があります（AC-8.12）。

### 保存形式とエクスポート形式は別物

- 保存形式（`localStorage`）: `entries` を `習慣 id → YYYY-MM-DD → 値` の**入れ子**にして
  います。5 MB quota 対策で、10 習慣 × 5 年（18,250 件）が 1 行 1 レコードの配列だと
  約 1.4 MB、入れ子なら約 0.3 MB。
- エクスポート形式（ファイル）: `format: "habit-tracker-export"` + `format_version`。
  **入れ子ではなく 1 行 1 レコードの配列で整形出力**します。ファイルの仕事は何年後でも
  読めることなので、quota 圧力で変わる保存形式に縛りません。
- **インポートは全置換**（マージしない）。適用前に必ず要約を見せ、`confirm()` は使いません。
- 最終エクスポート日は `habit-tracker.last-export` に別キーで持ちます。文書が読めない
  ときにも読めてほしく、かつインポートで上書きされてはいけない情報だからです。
- バッジの有効・無効も同じ理由で `habit-tracker.badge`（`"on"` / `"off"`）に別キーで
  持ちます。**「この端末の設定」を文書に入れないこと** — 入れるとスキーマ版が上がり、
  インポートで他人の端末の設定が飛んでくることになります。

### PWA / Service Worker

PWA 化は**データ保護の手段**です（体裁の話ではありません）。WebKit は 7 日間操作の
ない `localStorage` を削除し、ホーム画面に追加した web アプリだけを対象外にします。

- `client/vite.config.ts` の `serviceWorker` プラグインが、ビルド後の `dist` を走査して
  プリキャッシュ一覧とキャッシュ名（ビルド全体のハッシュ）を `client/sw.js` の先頭に
  差し込み、`dist/sw.js` を書き出します。**`vite-plugin-pwa` は使いません**（Phase 1 以降
  依存パッケージを 1 つも足していない方針。壊れたキャッシュを追うときに読めることが重要）。
- キャッシュ戦略: **ナビゲーションは network first / アセットは cache first**。アセット名に
  内容ハッシュが入るので cache first で安全です。「古い SW が新しいアプリを永久に
  キャッシュする」事故は、この 3 点（network first / 内容アドレス / ビルド毎の新キャッシュ）
  で防いでいます。ここを触るときはこの性質を壊さないこと。
- `npm run dev` では SW を登録せず、残っている登録を**能動的に解除**します（`pwa.ts`）。
- `base: "./"`（相対）。GitHub Pages のサブディレクトリ配信（`/habit-tracker/`）と
  ドメイン直下の**両方で同じ成果物が動く**ためです。代償として**ネストしたパスは非対応**
  （ルーターを足すならここを直す）。

### 通知（時刻指定のプッシュ通知は実装できません）

「リマインダー通知を追加して」は繰り返し出る要望ですが、**サーバー無しでは不可能です。**
実装に着手する前に `docs/design.md` の「判断とその理由 6」を読むこと。

- Web Push は送信主体としてサーバーと VAPID 鍵が必要 → 無料静的ホストの要件と両立しない
- `Notification Triggers`（時刻指定）は Chrome の origin trial で終了し**未出荷**
- `Periodic Background Sync` は iOS Safari **非対応**
- `setTimeout` + `showNotification()` はタブが生きている間だけ（iOS は PWA を停止する）

到達した答えは Phase 9 の 2 つです。**画面内のリマインダー**（`data/reminder.ts` の純関数）と
**アイコンのバッジ**（`pwa.ts` の `setBadge()`）。バッジは iOS が通知許可を要求し、
`Notification.requestPermission()` はユーザー操作起点でしか呼べないので、**明示的な
ボタンによる opt-in**です（読み込み時に要求しないこと。永久に拒否されます）。

**許可なし / API なし / reject は全て正常系**として「文だけ出る」に劣化させます。ここに
例外を投げる分岐を足さないこと（AC-9.7 / AC-9.8）。`client/sw.js` に `push` ハンドラを
足しても鳴らせません。

## 型チェックの制約

型ストリッピングで `.ts` を直接実行するため、`tsconfig.base.json` が以下を強制します。

- `erasableSyntaxOnly` … **`enum` / `namespace` / パラメータプロパティは使えません。**
  列挙は文字列リテラルのユニオン型で書きます。
- `verbatimModuleSyntax` … 型の import は必ず `import type`。
- `allowImportingTsExtensions` … **import は実際の拡張子を書きます**
  （`from "./document.ts"`, `from "../../../shared/types.ts"`）。パスエイリアスはありません。
- `noUncheckedIndexedAccess` / `noUnusedLocals` / `noUnusedParameters` も有効。

`npm run typecheck` はルートと client の 2 パスです。ルート側は `e2e/**` も含みます
（コンパイルできない spec は何も証明しないため）。

## この repo の開発フロー（2 エージェント体制）

`.claude/agents/` に **builder**（実装 + 単体テスト）と **reviewer**（E2E + PASS/FAIL 判定）
が定義されています。実装した本人が合否を出すと「通るように書かれたテストが通るだけ」に
なるため、`.harness/guard.mjs` が PreToolUse フックで書き込みを物理的に遮断します。

- builder は `e2e/` `.harness/` `.claude/agents/` `docs/phases.md` に書けません
- reviewer は `client/` `shared/` `package.json` `tsconfig.base.json` `docs/phases.md` に書けません

判定は `.harness/reviews/phase-<N>-attempt-<M>.md` に、2 行目が `VERDICT: PASS|FAIL` の形で
記録されます（過去分がコミット済み。各フェーズがどう通ったかの記録です）。

E2E を書く / 直すときの原則（reviewer 側の規約だが、spec を読む側も前提として必要）:

- **時刻は必ず固定されていること。** `e2e/fixtures.ts` が re-export する `test` が、最初の
  ナビゲーション前に `page.clock.install({ time: FIXED_NOW })` を済ませます
  （`@playwright/test` から直接 `test` を import すると実時計になります）。過去データは
  固定日からの相対日数で投入 — `FIXED_NOW` / `TODAY` / `daysAgo()` / `run()` と、
  `localStorage` に文書を直接流し込む `open()` / `seedRaw()` が同ファイルにあります。
- **ロールとアクセシブルネームで assert する**（`getByRole` / `getByLabel` / `getByText`）。
  CSS クラスや DOM 構造に依存しないこと。`fixtures.ts` に主要ロケータが集約されています。
- **`waitForTimeout` を使わない。** `retries: 0` なので flaky な PASS は PASS ではありません。
- 既存フェーズの spec は消さない（回帰スイートとして育てています）。

ヒートマップに手を入れるときは、**着手前に `dataviz` スキルを読むこと**（配色・凡例・
アクセシビリティの基準）。外部チャートライブラリは追加せず SVG を直接描いています。

## デプロイ

`master` / `main` への push で `.github/workflows/deploy.yml` が
typecheck → `npm test` → build → GitHub Pages 公開まで自動実行します。**落ちたら公開
されません。** E2E は CI（`ci.yml`, PR でも走る）側の担当で、deploy では繰り返しません。
deploy が CI と別ワークフローなのは、PR が公開できてはいけないためです。

`base` の設定は不要（上記「相対 base」参照）。GitHub Pages 側は Settings → Pages →
Source を「GitHub Actions」にする初回設定だけが必要です。

## 実態と合っていない記述に注意

歴史的経緯で、リポジトリ内に**もう有効でない記述が残っています**。これらを根拠に実装
しないこと。

- `docs/design.md` の「**データモデル**」「**API**」「**認証**」「**ディレクトリ構成**」の各節と
  SQLite 前提の行は無効（冒頭に警告あり）。ただし「**判断とその理由 1〜5 は全て有効**」です。
- `docs/phases.md` の Phase 1〜6 のうち、サーバー / SQLite / HTTP API / 認証に関する AC は
  無効（冒頭の表に一覧あり）。**それ以外の AC は今も満たし続ける必要があります。**
- `.claude/agents/builder.md` に「サーバー側に日付計算を持ち込まない」等のサーバー前提の
  文言が残っています。趣旨（日付はクライアントが決める）は有効です。
- `.env` と `data/habits.db` は撤去したサーバーの残骸で、どこからも読まれていません
  （どちらも gitignore 済み）。**アプリの動作に環境変数は 1 つも要りません。**
