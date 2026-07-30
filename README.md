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
| バックアップ | 画面の「バックアップ」から JSON ファイルにエクスポート / インポート |

ブラウザのサイトデータを消すと記録も消えます。プライベートブラウジングでは保存自体が
できず、その旨が画面に表示されます。

---

## ⚠ iPhone で使う場合は必ずホーム画面に追加してください

**Safari で開いたままにしていると、記録が 7 日で消えることがあります。**

WebKit（iOS Safari のエンジン）は、**7 日間そのサイトを操作しないと `localStorage` を
削除します**。このアプリのデータは端末の `localStorage` にしかないので、これは「記録が
全部消える」ということです。旅行や入院で 1 週間アプリを開かなかっただけで起こります。

例外はひとつだけで、**ホーム画面に追加した web アプリはこの対象外**です。ホーム画面の
アプリは Safari とは別に「使った日数」を数えており、WebKit は
*"We do not expect the first-party in such a web application to have its website data
deleted."* と書いています。

なお原文は "We do not expect"（消えないはず）であって保証ではありません。
**ホーム画面に追加したうえで、ときどきエクスポートしてください。** 両方やって初めて安全です。

### ホーム画面への追加手順（iPhone / iOS Safari）

1. **Safari で**アプリの URL を開く（Chrome など他のブラウザからは追加できません）
2. 画面下の**共有ボタン**（□ から↑が出ているアイコン）をタップ
3. メニューを下にスクロールして「**ホーム画面に追加**」をタップ
4. 名前（既定は「習慣」）を確認して右上の「**追加**」をタップ
5. ホーム画面に出たアイコンから起動する。アドレスバーもタブも出ない全画面表示になれば成功です

以後は**必ずホーム画面のアイコンから開いてください**。Safari のタブから開いたものと
ホーム画面のアプリは、**別々のデータ置き場**を持ちます。Safari 側で作った記録は
ホーム画面のアプリからは見えません（逆も同じです）。

> すでに Safari で記録を作ってしまっている場合は、
> **Safari 側でエクスポート → ホーム画面のアプリでインポート**すれば引き継げます。

## バックアップ（エクスポート / インポート）

画面の「バックアップ」カードから操作します。

- **エクスポート** … `habit-tracker-YYYY-MM-DD.json` をダウンロードします。iPhone では
  「ファイル」アプリや iCloud Drive に保存できます。**削除した習慣とその記録も含まれます**
- **インポート** … ファイルを選ぶと「習慣 3 件 / 記録 120 件 / 期間 …」という要約が出ます。
  内容を確認して「インポートを実行」を押して初めて反映されます。
  **インポートは全置換です**（いま端末にある記録は置き換わります）
- 壊れたファイルや別アプリの JSON を選んでも、**いまのデータは一切変更されません**。
  読めなかった理由が表示されるだけです
- 最後にエクスポートした日付がカードの先頭に出ます。一度もしていなければそう表示され、
  30 日以上経つと一度だけ静かに知らせます

### 保存データが読めなくなったときは

ブラウザの不調などで保存データが壊れると、アプリは**上書きを止めて**エラーを表示します
（消えたデータを空で上書きするのが最悪だからです）。この状態でも「バックアップ」カードは
画面の一番上に出ていて、そこから復旧できます。

1. 「**壊れたデータをファイルに書き出す**」で、読めなかったバイト列をそのまま保存しておく
2. バックアップがあれば「**バックアップファイル**」から復元する
3. 無ければ「**データを初期化する**」→ チェックを入れる →「**すべての記録を削除する**」

初期化はチェックボックスを入れないと押せません。誤タップでは発火しません。

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

`client/dist` の中身は HTML / CSS / JS / PNG だけです。Node プロセスは要らないので、
任意の静的ホスティング（GitHub Pages, Cloudflare Pages, Netlify …）にそのまま
置けます。SPA フォールバック（`/` 以外のパスも `index.html` に返す）は**不要**です。
画面が 1 つしかなく、オフライン時は Service Worker が自分でシェルに寄せるためです。

ホーム画面への追加（PWA）を成立させるには **HTTPS が必要**です（`localhost` は例外）。
上記のホスティングはいずれも既定で HTTPS です。

## デプロイ（GitHub Pages）

`master` / `main` に push すると `.github/workflows/deploy.yml` が
型チェック → 単体テスト → ビルド → 公開まで行います。落ちたら公開されません。

初回だけリポジトリ側の設定が必要です。

1. GitHub のリポジトリ → **Settings** → **Pages**
2. **Build and deployment** の **Source** を「**GitHub Actions**」にする
   （「Deploy from a branch」ではありません）
3. 次の push、または Actions タブから **Deploy to GitHub Pages** を手動実行

公開先は `https://<ユーザー名>.github.io/<リポジトリ名>/` です。

### `base` を設定しなくてよい理由

GitHub Pages のプロジェクトページはサブディレクトリ配信になります
（`/habit-tracker/`）。`client/vite.config.ts` は `base: "./"`、つまり**相対**なので、
**同じビルド成果物がドメイン直下でもサブディレクトリでも動きます**。E2E は直下で
実行していますが、検証しているバイト列は公開されるものと同一です。

代償は、**ネストしたパスを URL に直接入れても動かない**ことです
（`/habit-tracker/foo/bar` は相対パスが 1 階層深く解決される）。オフライン時は
Service Worker がシェルへ 302 で寄せるので実害はなく、画面が 1 つでルーターも
無いため通常この URL には到達しません。ルーティングを足すときはここを直してください。

### 注意: `github.io` は origin をユーザー単位で共有します

`https://<ユーザー名>.github.io/` 配下のプロジェクトページは、**すべて同じ origin**
です。`localStorage` は origin 単位なので、同じアカウントで別のアプリを GitHub Pages
に置くと、**記録は同じ保存領域に同居します**。このアプリのキーは `habit-tracker`
で名前空間が分かれているため衝突はしませんが、別のアプリが `localStorage.clear()` を
呼べば記録は消えます。気になるなら独自ドメインか Cloudflare Pages を使ってください。

## PWA と Service Worker

- `client/public/manifest.webmanifest` … `display: standalone` とアイコン。相対 URL なので
  サブディレクトリに置いても動きます
- `client/sw.js` … Service Worker の本体。**依存パッケージは足していません**
  （`vite-plugin-pwa` は使っていません）。`client/vite.config.ts` の `serviceWorker`
  プラグインが、ビルド後の `dist` を走査してプリキャッシュ一覧とキャッシュ名を先頭に
  差し込み、`dist/sw.js` を書き出します
- キャッシュ戦略は **ナビゲーションは network first / アセットは cache first**。
  アセット名にはビルドハッシュが入っているので cache first で安全です。キャッシュ名は
  ビルド全体のハッシュなので、新しいビルドは必ず新しいキャッシュになり、`activate` で
  古いものを消します。**「古い Service Worker が新しいアプリを永久にキャッシュする」
  事故はここで防いでいます**
- **開発時（`npm run dev`）は Service Worker を登録しません。** それどころか、同じ
  オリジンに残っている登録を能動的に解除します（`client/src/pwa.ts`）。編集が反映
  されない原因になるためです

アイコンはリポジトリ内で生成しています（外部素材ゼロ）。

```bash
npm run icons     # scripts/icons.ts が client/public/ に PNG を書き出す
```

出力はコミット済みなので、通常はこのコマンドを実行する必要はありません。
`npm test` が「コミット済みの PNG が今のコードの描くものと一致するか」を検査します。

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
├── scripts/
│   ├── icons.ts             # アイコンの描画と PNG エンコード（純関数）
│   └── generate-icons.ts    # それをファイルに書き出す（npm run icons）
└── client/
    ├── vite.config.ts       # dist/sw.js を生成するプラグインを含む
    ├── sw.js                # Service Worker 本体
    ├── public/              # manifest.webmanifest とアイコン
    └── src/
        ├── data/document.ts # 保存データの形式・版管理・全操作（純関数）
        ├── data/backup.ts   # エクスポート形式と、インポートの検証（純関数）
        ├── data/store.ts    # localStorage の読み書き（同期）
        ├── pwa.ts           # SW 登録と navigator.storage.persist()
        ├── hooks/, components/
        └── errors.ts        # 画面に出す日本語メッセージ
```

`localStorage` は同期 API なので、保存層も同期のままです。保存データにはスキーマ
版番号が入っていて、読めない JSON や未知の版に出会ったときは **上書きせずに** 画面に
エラーを出します（消えたデータを取り戻す手段が無い以上、黙って作り直すより安全です）。
