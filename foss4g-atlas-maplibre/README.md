# FOSS4G Atlas — MapLibre GL JS 実装

`foss4g_usage.geojson`（WGS 84 / EPSG:4326、Point 230 件）を MapLibre GL JS で描画する
スタンドアロン実装です。FOSS4G Atlas Artifact と同じ配色・タイポグラフィ・UI 構成を、
ライブラリ側のレイヤー定義に移し替えてあります。

## 構成

```
.
├── index.html            マークアップと CDN 参照
├── foss4g-atlas.css      デザイントークン（ライト/ダーク）と UI
├── foss4g-atlas.js       データ読み込み、レイヤー定義、凡例・年別グラフ・一覧表
└── data/
    ├── foss4g_usage.geojson   使用記録 230 件（Point / WGS 84）
    └── world_land.geojson     陸地ポリゴン（Natural Earth 110m を簡略化）
```

## 実行

`fetch` を使うため `file://` では動きません。フォルダ直下で HTTP サーバを立ててください。

```sh
python3 -m http.server 8000
# → http://localhost:8000/
```

MapLibre GL JS は CDN から読み込みます（`index.html` 冒頭でバージョン固定）。
社内ネットワークで CDN が使えない場合は `npm pack maplibre-gl@4.7.1` で取得し、
`dist/maplibre-gl.js` と `dist/maplibre-gl.css` をローカルに置いて参照先を差し替えてください。

## ベースマップの切り替え

`foss4g-atlas.js` 冒頭の `CONFIG.basemap` を変えるだけです。

| 値 | 内容 |
|---|---|
| `'flat'`（既定） | `data/world_land.geojson` の陸地ポリゴンと自動生成した経緯線のみ。**通信不要**。Artifact と同じ見た目。 |
| `'vector'` | CARTO のキー不要ベクタースタイル。ライトは Positron、ダークは Dark Matter を自動で使い分け。 |
| `'raster'` | 任意のラスタタイル。`CONFIG.raster.tiles` を自分の配信元に差し替えて使う。既定値は OSM のタイルを指していますが、本番利用の際は必ず自前のタイルサーバか商用サービスに変更してください（OSM の Tile Usage Policy）。 |

`'raster'` ではタイルの彩度と明度を落として記号を前面に出す `paint` を当てています。

## 描画の考え方

### 1. 色は必ず CSS カスタムプロパティから取る

レイヤーの `paint` に色リテラルを書かず、`token('--c-global')` のように
`getComputedStyle` 経由で CSS 変数を読みます。トークンの定義は `foss4g-atlas.css`
の `:root` / `@media (prefers-color-scheme:dark)` / `:root[data-theme="dark"]` の
3 ブロックだけにあり、テーマ切り替え時は `restyle()` が `map.setStyle()` →
`styledata` 待ち → `addOverlay()` の順でオーバーレイを作り直します。

### 2. 都市 × 分類で集約し、分類ごとに別レイヤーへ

生の 230 点をそのまま描くと東京・札幌・ソウルなどで完全に重なります。
`dotsGeoJSON()` が `city` × `country` × `category` で集約して `count` を持つ点に変換し、
分類ごとの circle レイヤーに `filter: ['==', ['get','category'], key]` で振り分けます。

同一都市内で分類が重ならないよう、各レイヤーに `circle-translate` で
正六角形状の固定ピクセルオフセットを与えています。

```js
'circle-translate': OFFSET[c.key],           // 例 [0, -9]
'circle-translate-anchor': 'viewport'
```

`circle-translate` はレイヤー単位のペイントプロパティなので、
データ駆動式を書かずに済み、式が単純で描画も軽くなります。

### 3. 半径は件数の平方根で

円の**面積**が件数に比例するよう `['sqrt', ['get','count']]` に対して補間し、
さらにズームでも段階的に大きくします。

```js
'circle-radius': [
  'interpolate', ['linear'], ['zoom'],
  1, ['interpolate', ['linear'], ['sqrt', ['get','count']], 1, 4.2, 3.5, 11],
  6, ['interpolate', ['linear'], ['sqrt', ['get','count']], 1, 7,   3.5, 18]
]
```

### 4. ホバーは feature-state、ツールチップは自前の div

ソースに `generateId: true` を付けて `setFeatureState({hover:true})` で
`circle-stroke-width` を太らせます。吹き出しは MapLibre の `Popup` ではなく
`.tip` の div をマウス追従させ、Artifact と同じ見た目を保っています。

### 5. 経度ループを止める

`renderWorldCopies: false` で世界の複製描画を切り、
`dragRotate` / 回転を無効にして一枚地図として扱います。

## 操作

| 操作 | 動作 |
|---|---|
| 凡例をクリック | 分類レイヤーの表示/非表示（`setLayoutProperty`）と一覧表の絞り込み |
| 年別グラフのバー | その年だけに絞り込み（もう一度で解除）。ソースを `setData` で差し替え |
| 円をクリック | 一覧表をその都市名で検索して表示位置へスクロール |
| 一覧表の行をクリック | 地図をその地点へ `easeTo` |
| 表ヘッダをクリック | 年 / 分類 / 名称 / 場所でソート（再クリックで昇降反転） |
| 自動 / 明 / 暗 | テーマ切替。「自動」は OS 設定に追従 |

## データ仕様

各 Feature は Point ジオメトリと以下の properties を持ちます。

| プロパティ | 内容 |
|---|---|
| `id` | 連番 |
| `category` | `origin` / `global` / `regional` / `national` / `paper` / `product` |
| `category_ja` | 分類の日本語表記 |
| `year` | 年（2003–2027） |
| `when` | 具体的な会期など。無い場合は空文字 |
| `name` | 名称 |
| `city`, `country` | 都市名・国名 |
| `description` | 内容の説明 |
| `confidence` | `confirmed` / `unverified`（後者は一覧表で「要確認」を表示） |
| `source_url` | 出典 URL |

座標は都市の代表点であり、会場や機関の正確な位置ではありません。
`unverified` の 22 件は開催都市・所属都市・開始年のいずれかが一次情報で
確定できていないものです。

## ライセンス・出典

- 記録データ: 各 Feature の `source_url` を参照（OSGeo Wiki、各カンファレンス公式サイト、
  ISPRS Archives、J-STAGE ほか）
- 陸地ポリゴン: [Natural Earth](https://www.naturalearthdata.com/) 110m Admin 0 Countries（public domain）
- MapLibre GL JS: BSD-3-Clause
