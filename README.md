# 習慣トラッカー

個人用の習慣トラッカー。**サーバーはありません。** ブラウザだけで動く静的サイトで、
記録は開いている端末の `localStorage` に保存されます。

- 仕様と受け入れ基準: [`docs/phases.md`](docs/phases.md)
- 設計の背景: [`docs/design.md`](docs/design.md)

## データの置き場所

| | |
| --- | --- |
| 保存先 | ブラウザの `localStorage`（キー: `habit-tracker`） |
| 同期 | **しません。** 別の端末・別のブラウザからは見えません |
| ログイン | **ありません。** 認証する相手のサーバーが無く、データは端末内にしかないため |
| バックアップ | 現時点ではありません（エクスポート機能は Phase 8 で入ります） |

ブラウザのサイトデータを消すと記録も消えます。プライベートブラウジングでは保存自体が
できず、その旨が画面に表示されます。

## 必要環境

- Node.js 22.18 以上（TypeScript の型ストリッピングを使うため）
  - `node --version` で確認。これ未満では単体テストが動きません
- それ以外は不要です（DB も Docker も環境変数も要りません）

## セットアップ

クリーンな clone から、この 2 コマンドで動きます。設定ファイルはありません。

```bash
npm install
npm run dev               # http://localhost:5173 を開く
```

`npm install` は Playwright のブラウザまでは入れません。E2E を動かすときだけ
`npx playwright install chromium` を実行してください（アプリの起動には不要です）。

## 本番相当の起動

```bash
npm run build     # client/dist に静的ファイルを生成
npm run preview   # 生成物をそのまま配信して確認（http://localhost:4173）
```

`client/dist` の中身は HTML / CSS / JS だけです。Node プロセスは要らないので、
任意の静的ホスティング（GitHub Pages, Cloudflare Pages, Netlify …）にそのまま
置けます。サーバー側の設定は **`/` 以外のパスも `index.html` に返す**（SPA
フォールバック）だけで、それも今のところ画面が 1 つしかないため必須ではありません。

## 検査

```bash
npm test          # node:test 単体テスト（shared の統計 / client の保存層と表示ロジック）
npm run typecheck # 型チェック（ルート / client）
npm run e2e       # Playwright E2E（本番ビルドに対して実行）
```

`npm run e2e` は初回のみ `npx playwright install chromium` が必要です。E2E は
ビルド済みの `client/dist` を配信して実行し、ブラウザのプロファイルは毎回新しく
作られるので、開発中に手元へ入れたデータには触りません。

## 構成

```
├── shared/          # ドメインルール（純関数。ここに副作用は無い）
│   ├── domain.ts    #   isAchieved() — 達成判定の唯一の定義
│   ├── stats.ts     #   ストリークと達成率
│   └── heatmap.ts   #   ヒートマップの格子と濃淡
└── client/
    ├── vite.config.ts
    └── src/
        ├── data/document.ts  # 保存データの形式・版管理・全操作（純関数）
        ├── data/store.ts     # localStorage の読み書き（同期）
        ├── hooks/, components/
        └── errors.ts         # 画面に出す日本語メッセージ
```

`localStorage` は同期 API なので、保存層も同期のままです。保存データにはスキーマ
版番号が入っていて、読めない JSON や未知の版に出会ったときは **上書きせずに** 画面に
エラーを出します（消えたデータを取り戻す手段が無い以上、黙って作り直すより安全です）。
