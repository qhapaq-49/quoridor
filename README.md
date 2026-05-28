# Quoridor AI

GitHub Pages でそのまま動く、ビルド不要のコリドール実装です。

## 機能

- 2人戦と4人戦
- 各席の人間 / AI 切り替え
- 横壁・縦壁の合法判定、全員の到達経路維持チェック
- ジャンプと斜めジャンプ
- AI候補手の表示
- AIのランダム性調整

## AI方針

ブラウザで動かすため、全合法壁を深く読む設計にはしていません。主対象は2人戦です。4人戦も遊べますが、他プレイヤーの利害が不安定なのでAIは応答性を優先して浅く読みます。

gorisanson/quoridor-aiをベースラインにしています。候補壁は1本の最短路だけでなく、全最短路DAGを見て候補化します。距離を伸ばす壁を最重視しつつ、最短路の幅を削る壁にも小さな価値を与えます。そのうえで短い時間制限のalpha-beta探索を行い、最短路差、壁残数、即勝ち・即負け、可動性を評価します。

AIの着手は常に最上位固定ではなく、評価上位の手からソフトマックスで選びます。強さを保ちながら対局ごとの変化を出すためです。

## ローカル確認

```bash
npm test
npm run check
```

gorisanson/quoridor-aiを/tmpに展開した状態なら、自動対戦も走らせられます。

```bash
node scripts/benchmark-gorisanson.js --games 4 --rollouts 2500 --our-strength strong --our-randomness 0
```

## 現在のベンチと開発状況

同一Node環境での少数局ベンチです。サンプル数はまだ小さいため、レート推定ではなく退行検知用です。現在は強化中で、gori 60kに対する勝ち越しはまだ未達です。

- gori 2,500 rollouts: `--our-time-limit 950 --our-max-depth 4 --our-wall-limit 6` で直近2局は1-1。別seedでは2-0もあり、まだ安定しません。
- gori 7,500 rollouts: 同1秒弱設定では直近1局0-1。depth5も1局0-1で、序盤から中盤の壁交換に改善余地があります。
- 自己対局: `scripts/self-play.js` でA/B比較を実行可能。履歴回避、序盤本の非対称、alpha-betaキャッシュの不正確さを検出して修正しました。
- 実験用MCTS: gori 1,000には勝てる局面がある一方、gori 2,500には不安定だったため現時点では不採用です。

gori 60,000 rolloutsは固定局面で約10.6秒/手でした。

静的ファイルだけなので、`index.html` を開けば遊べます。ローカルサーバーで確認する場合は任意の静的サーバーを使ってください。

## 参照した先行事例

- gorisanson/quoridor-ai: MCTSにヒューリスティックを加えたWeb実装。壁候補の絞り込み、ロールアウトで最短路を重視する方針、定石導入が参考になる。https://github.com/gorisanson/quoridor-ai/
- Victor Massague Respall, Joseph Alexander Brown, Hamma Aslam, "Quoridor agent using Monte Carlo Tree Search"。MCTSが既存エージェントに有効だったという卒業論文。https://upcommons.upc.edu/entities/publication/1d505cb6-b3b4-4411-907c-ae4182f8eaad
- GitHub topic `quoridor`: MCTS、alpha-beta、negamax、transposition table などのOSS実装が複数ある。https://github.com/topics/quoridor
- Quoridor rules summary: 2人/4人、壁数、ジャンプ、到達経路維持のルール確認。https://www.ultraboardgames.com/quoridor/game-rules.php
- Hyperlode Quoridor rules: 2人戦の壁・ジャンプ・斜めジャンプの確認。https://hyperlode.github.io/quoridor/Rules/quoridor_rules.html
