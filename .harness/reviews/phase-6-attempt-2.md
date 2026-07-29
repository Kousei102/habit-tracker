# Phase 6 review — attempt 2
VERDICT: PASS

## 受け入れ基準

| ID | 判定 | 根拠 |
|----|------|------|
| AC-6.1 | PASS | e2e/specs/phase6-polish.spec.ts:140, :200。E2E は毎回 `npm run e2e:serve`（build + `node server/src/index.ts` 単体）に対して実行されており、83 spec 全てがその 1 プロセス経由で通っている |
| AC-6.2 | PASS | Phase 1〜5 の 55 spec が本番ビルドに対して全て通過（1:5 / 2:13 / 3:13 / 4:12 / 5:12） |
| AC-6.3 | PASS | attempt 1 でクリーン複製から README どおりに起動確認済み。今回の変更は `client/src/styles.css` と `client/src/components/HeatmapPanel.tsx` の 2 ファイルのみで、`package.json` / README / `.env.example` / セットアップ手順は無変更（差分確認済み） |
| AC-6.4 | PASS | e2e/specs/phase6-polish.spec.ts:284, :300, :334, :346, :373, :388, :426。10 経路とも再実行して通過 |
| AC-6.5 | **PASS**（attempt 1 の FAIL が解消） | e2e/specs/phase6-polish.spec.ts:489（3 幅の操作）, :627（最大長データ × 3 幅 × 3 ビュー）, :698（19 文字の通常ケース） |
| AC-6.6 | PASS | e2e/specs/phase6-polish.spec.ts:242 |

## ブロッキング指摘

なし。

## attempt 1 の指摘の解消確認

`client/src/styles.css:474` の `.heatmap__picker select { min-width: 0; flex: 1 1 auto; text-overflow: ellipsis; }`
（＋ `.heatmap__picker label { flex: none }`）で解消されています。

**同一コードに対する before / after の実測**（375px、習慣名 19 文字「毎朝のストレッチと深呼吸をきちんとやる」）:

| | `body` 横スクロール | `documentElement` | 右端をはみ出す要素 | セレクタの right |
|---|---|---|---|---|
| attempt 1 | 53px | 53px | `select@428` | 428（viewport 375） |
| attempt 2 | 0 | 0 | なし | 338 |

**変更の 2 ファイル限定は事実です。** attempt 1 レビュー時に取ったワークツリーの複製と
`diff -rq` で突き合わせ、`client/src/components/HeatmapPanel.tsx` と `client/src/styles.css` の
2 ファイル以外は `server/` `shared/` `docs/` `package.json` `README.md` `.env.example` を含めて
バイト単位で同一であることを確認しました。

## builder が見つけた「別口の overflow」（`.habit__progress`）の検証

**回帰なし。修正は妥当で、AC-3.2 / AC-3.4 に実害は出ていません。**

`white-space: nowrap` の除去は AC-3.2 に直撃する変更なので、報告を信じずに実測しました。

### 1. AC-3.2 の例そのもの（e2e/specs/phase6-polish.spec.ts:730）

375 / 768 / 1280px の全てで、進捗行のテキストが**厳密に**`0 / 30 分` であり、
かつ高さ 25.59px < line-height 25.6px × 1.5 ＝ **1 行**に収まっていることを確認。
`toContainText` ではなく `getByText(..., { exact: true })` で見ているので、
`0 / 30` と `分` が別行になれば（テキストノードの正規化結果が変わる前に）高さ側で必ず落ちます。

### 2. 現実的な 5 パターン（e2e/specs/phase6-polish.spec.ts:785）

「不自然な折り返しが起きていないか」は例 1 つでは判断できないので、
桁数・単位長・小数の異なる 5 通りを 3 幅で計測しました。**全 15 通りで高さ = line-height（1 行）**:

| 表示 | 375px | 768px | 1280px |
|---|---|---|---|
| `0 / 30 分` | 1 行 | 1 行 | 1 行 |
| `120 / 100 回` | 1 行 | 1 行 | 1 行 |
| `1500 / 2000 ページ` | 1 行 | 1 行 | 1 行 |
| `12345 / 10000 歩` | 1 行 | 1 行 | 1 行 |
| `90.5 / 180 分間の学習` | 1 行 | 1 行 | 1 行 |

`overflow-wrap: anywhere` が通常データで発動していないことを、高さの実測で確認しています。

### 3. AC-3.4 の読み替え（同 :730 の後半）

375px のまま 3 → `3 / 30 分` ＋ 未達成、30 → `30 / 30 分` ＋ 達成、
リロード後も `30 / 30 分` ＋ 達成。いずれも 1 行のまま。

### 4. 折り返しが起きるのは最大長ケースのみ

習慣名 60 文字 + 単位 12 文字 + `1000000 / 1000000` の最悪ケースでは、375px で進捗行が
2 行（実測 51px / line-height 26px）になります。これは `nowrap` を外した以上当然の帰結で、
**テキストは欠けておらず全文が読めます**。1 行に固定して 30px ページを横スクロールさせるより
こちらが正しい取引だという builder の判断に同意します。

## builder が判断を仰いだ 1 件（`input.habit__number` の要素内スクロール）

**許容します。AC-6.5 の「レイアウトが破綻」には当たらないと判断しました。**

再現は確認しました。最大長ケース・375px で `input.habit__number` は
`scrollWidth=102 / clientWidth=86`（16px の要素内スクロール）になります。
判断の根拠:

1. **`<input>` が自分の値をスクロールさせるのは、あらゆるブラウザのあらゆるテキスト系入力の
   標準挙動**であって、レイアウトの破綻ではない。CSS で作り込んだ overflow とは別物です。
   attempt 1 で私が書いた「`overflow-x` が auto/scroll でない要素の内部 overflow を禁止」は
   AC ではなく私のヒューリスティックで、ネイティブフォームコントロールまで含めたのは
   その書き方が雑だったということです。
2. **ページ側への影響がゼロ**であることを実測で確認: 最大長データ × 375/768/1280px ×
   全体／有効な習慣／削除済み習慣ビューの **9 通り全て**で
   `body` = 0、`documentElement` = 0、右端をはみ出す要素 = 0。
3. **利用者が困らないことを、消極的な除外ではなく積極的な assertion で押さえました**
   （e2e/specs/phase6-polish.spec.ts:679〜）:
   - 入力欄自体はビューポート内に完全に収まっている
   - 値の全文は隣の進捗行が `1000000 / 1000000 ペペペペペペペペペペペペ` と表示しており、
     入力欄が見切れても読める
   - 375px のまま入力欄に `12` を打ち込め、保存され、リロード後も `12` が残る（操作可能）

spec 側では `INPUT` / `TEXTAREA` / `SELECT` を内部スクロール検査から除外し、
その理由をコメントに残してあります。「気づかず素通り」ではなく「意識して除外した」形です。

## 今回の変更が attempt 1 で PASS だった項目を壊していないかの確認

- **`title` 属性の追加 → アクセシブルネームに影響なし**（e2e/specs/phase6-polish.spec.ts:834）:
  - `getByRole("combobox", { name: "表示する習慣" })` が 1 件
  - `toHaveAccessibleName("表示する習慣")` が、選択前も習慣選択後も成立
  - `title` には選択中のラベル全文が入っている（`toHaveAttribute("title", name)`）
  - `getByRole("option", { name })` も 1 件のまま（option の `title` はアクセシブルネームを奪っていない）
- **ヒートマップのツールチップ（`aria-label` 一本化）に影響なし**（同 :834）:
  - セルは `title` 属性を持たない（`getAttribute("title")` が null）ので、
    ブラウザ標準のツールチップがアプリのツールチップと二重に出ることはない
  - セルにホバーすると、セルのアクセシブルネームと**同一文字列**のツールチップが 1 つだけ出る
- **Cookie の `Secure`**（:938, :958）、**`useToday` の日跨ぎと無限フェッチの不在**（:887）、
  **restore の 404 と本文同一性**（:1071）、**`include_archived=1` のスコープ**（:1102）、
  **AC-2.8 のログアウト**（:471）、**AC-3.6 の削除と取り消し**（:1046）、
  **目標なし数値習慣**（:1008）— いずれも再実行して通過。
- **AC-6.1 / AC-6.3 / AC-6.6** — 変更 2 ファイルに `package.json` / README / `.env.example` /
  サーバーコードが含まれないことを差分で確認済み。AC-6.1 は 83 spec が本番ビルド経由で
  通っていること自体が継続的な確認になっています。

## spec の強化と、それが本当に回帰を捕まえることの証明

attempt 1 の指摘「短い名前しか使わない spec だと素通りする」への対処として、
`e2e/specs/phase6-polish.spec.ts` を 24 → 28 テストに増やしました。

- `:627` **最大長データ**（習慣名 60 文字 / 単位 12 文字 / 目標・実績とも 1,000,000 /
  40 文字の削除済み習慣）を **3 幅 × 3 ビュー = 9 通り**で計測。
  数値は思いつきではなく `server/src/routes/habits.ts` の `MAX_NAME_LENGTH=60` /
  `MAX_UNIT_LENGTH=12` / `MAX_TARGET=1_000_000` と
  `server/src/routes/entries.ts` の `MAX_VALUE=1_000_000` から取っています。
- `:698` **19 文字という「ごく普通の」ケース**を独立したテストとして残置。
  極端ケースだけ対処した修正でも落ちるようにするためです。
- `:730` / `:785` 進捗行の**1 行性を高さで実測**（AC-3.2 / AC-3.4 の回帰ガード）。
- `:834` `title` 追加のアクセシビリティ影響。

**捕捉力の証明（推測ではなく実行結果）**: attempt 1 のソースツリー（レビュー時に取った複製、
`styles.css` と `HeatmapPanel.tsx` が修正前）に**今回の強化済み spec をそのまま載せて**
ビルド・実行したところ、狙いどおり 2 件が落ちました:

```
✘ AC-6.5: even the widest content the product accepts does not scroll the page
    body:53 root:53 pastRightEdge:["p.habit__progress@405","select.@428"]
✘ AC-6.5: an ordinary long habit name does not scroll the page either
    body:53 root:53 pastRightEdge:["select.@428"]
✓ AC-3.2 regression: '0 / 30 分' stays on one readable line at every width
✓ AC-3.2 regression: ordinary progress lines do not wrap at any width
```

`<select>` 由来と `.habit__progress` 由来の**両方**を名指しで捕まえています。
AC-3.2 の 2 件が修正前コードでも通るのは正しい挙動です（あれは修正を守るための回帰ガードであって、
バグを検出するためのものではない）。

## ネガティブコントロール

新規 assertion が空振りしていないことの確認。**4 つとも落ちることを確認してから元に戻しました。**

1. 進捗行の期待テキストを `0 / 30 分` → `0 / 31 分` に → 落ちる（ロケータが厳密に効いている）
2. 1 行判定の許容を `lineHeight * 1.5` → `* 0.5` に → 落ちる（高さが実測されていて NaN/0 ではない）
3. セレクタの `title` 期待値を実在しない値に → 落ちる
4. 「右端はみ出しゼロ」を `.not.toEqual([])` に反転 → 落ちる（配列が計算された上で空である）

加えて、`page.addStyleTag` で修正だけを打ち消した状態（`min-width: auto` / `flex: 0 1 auto` /
`white-space: nowrap` に戻す）でも `body` = 53px、はみ出し要素 = `p.habit__progress@405` と
`select.@428` になることを確認しています。

## 非ブロッキングの所見

1. **最大長データでは進捗行が 375px で 2 行になります。** テキストは完全で読めるので許容ですが、
   単位を `text-wrap: balance` などで扱うか、極端に長い単位を UI 側で丸めるかは将来の検討課題。
   AC には無いので今フェーズでは何もしなくてよいです。
2. `.heatmap__picker select` の `text-overflow: ellipsis` は、`<select>` に対しては
   ブラウザ依存の効き方をします（Chromium では効きます）。効かないブラウザでも
   `min-width: 0` によるページ横スクロールの解消は成立するので、実害はありません。
3. `title` 属性はタッチデバイスでは表示されません。長い習慣名の全文は
   ドロップダウンを開けば読めるので致命的ではありませんが、
   ポインタ前提の補助であることは記録しておきます。
4. attempt 1 で挙げた所見（`target: ""` の受理、削除通知が live region でない、
   375px でフォームが縦方向に画面外）は今回も未変更のまま残っています。いずれも非ブロッキングです。

## 実行結果

- `npm run typecheck`（root / server / client）: PASS
- `npm test`: 172 passed / 0 failed（44 suites）
- `npx playwright test`: **83 passed / 0 failed**（expected 83, unexpected 0, flaky 0, skipped 0）
  - Phase 1〜5: 55 passed / 0 failed（AC-6.2）
  - Phase 6: 28 passed / 0 failed
- 追加の手動検証: attempt 1 のソースツリーに強化済み spec を載せた再現実行（2 件が期待どおり失敗）、
  `diff -rq` による「変更は 2 ファイルのみ」の確認
