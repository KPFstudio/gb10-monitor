# GB10 Monitor

NVIDIA GB10 システム（DGX Spark、ThinkStation PGX、ASUS GX10、互換 Linux ホスト）向けの、超軽量・ゼロ依存の Web モニターです。

English: [README.md](README.md)（[日本語](README.ja.md)）

各ホストへ SSH でアクセスし（GPU・メモリ・全 thermal zone・ロード平均）、スマホでもちらっと見られる単一ページの自動更新ダッシュボードを提供します。意図的に軽量です：Docker なし、DB なし、Prometheus なし、認証なし。

## なぜ作ったか

GB10 を24時間 LLM 推論に使うと、GPU 温度だけでは足りないことにすぐ気づきます。GPU が快適な70℃台でも、**一番熱い thermal zone** は90℃超になることがあります。また、瞬間的に92℃を記録したのと、1分平均92℃なのでは意味が違います。

このツールは一目で答えます：**そのクラスタ、本当に熱い？ それとも一瞬だけ上がっただけ？**

各ホストでは以下を表示します：

- **ベンダー＋製品名を自動検出**（DMI の `sys_vendor` / `product_name` / `product_version` から取得）— 例：`LENOVO · ThinkStation PGX`、`ASUSTeK · GX10`、`NVIDIA · DGX Spark`。どんな GB10 システム（DGX Spark、ThinkStation PGX、ASUS GX10、MSI、その他の互換 Linux ホスト）でも動きます。`config.json` でホストごとに上書きも可能です。
- GPU 温度 / 消費電力 / 使用率
- 統合メモリ、ロード平均
- **一番熱い thermal zone**（現在値＋1分平均・5分平均・15分平均、5分最大）
- 最近の温度推移の小さなスパークライン
- どの zone が一番熱いか（`thermal_zone0 (acpitz)` など）— ある zone を「SoC そのもの」と決め打ちしません
- ホストごとの一目で分かるステータス。判定は**瞬間値ではなく1分平均**ベース

**台数は何台でも動きます** — 1台、2台、4台、6台、それ以上。`config.json` に並べるだけでグリッドが自動配置され、スマホのまとめ表示では1画面に収まります。

2つの表示（上部で切替）：

- **詳細** — 上記の全項目をホストごとに表示
- **まとめ** — スマホ向けのコンパクトなグリッドで、**全ホストを1画面に**収める（各ホストにオンライン状態・ステータス・現在値・1分/5分/15分平均・ミニスパークライン）

レイアウトはレスポンシブで、**英語・日本語・簡体字中国語**に対応（ブラウザ言語を自動検出、右上で切替可）。狭い画面ではまとめ表示で開きます。

> これは意図的に**フルクラスタ管理ツールではありません**。マルチノード制御、LLM サーバーメトリクス、ベンチマーク、電源制御が必要なら、専用ツールを使いましょう。これは熱監視ファースト＆SSH のみです。

## 必要要件

- ダッシュボードを動かすマシンに Node.js ≥ 16
- そのマシンから各 GB10 ホストへの SSH（鍵）アクセス
- リモートは Linux（`/sys/class/thermal`、`nvidia-smi`、`free`、`/proc/loadavg`）

## 1. SSH の設定

各ノードへ鍵で非対話に SSH できることを確認します：

```bash
ssh dgx1 nvidia-smi
```

パスワードを求められたら、先に鍵認証を設定してください。エイリアス・ポート・ユーザー名は `~/.ssh/config` に書きます。例：

```
Host gb10-1
  HostName 192.168.1.50
  User ubuntu
  IdentityFile ~/.ssh/id_ed25519
```

## 2. ホストの設定

```bash
cp config.example.json config.json
```

`config.json` を編集します：

```json
{
  "port": 8910,
  "pollMs": 5000,
  "sshTimeoutMs": 8000,
  "hosts": [
    { "ssh": "gb10-1", "label": "GB10 node 1" },
    { "ssh": "gb10-2", "label": "GB10 node 2" }
  ],
  "thresholds": {
    "gpuWarn": 75,
    "gpuHot": 85,
    "socNote": 85,
    "socWarn": 90,
    "socHot": 93,
    "peak": 95
  }
}
```

- `hosts[].ssh` は手順1の SSH エイリアス / ホスト名です。
- `hosts[].label` は表示名です（任意 — 製品名は自動検出されます）。
- `hosts[].model` は、検出された製品名を上書きしたい場合の任意指定です。
- `port`、`pollMs`、`sshTimeoutMs` は任意です。`PORT` 環境変数で `port` を上書きできます。

> **LLM / エージェントに優しい：** 設定は意図的に小さく自己説明的です。クローン → `cp config.example.json config.json` → `hosts` 配列を編集 → `node server.js` だけです。

## 3. 起動

```bash
node server.js        # または: npm start
```

## 4. ダッシュボードを開く

```
http://127.0.0.1:8910/
```

ページは自動更新されます。スマホから見たい場合は Tailscale Serve（または任意の TLS リバースプロキシ）で tailnet に公開します：

```bash
tailscale serve --bg --https=8910 http://127.0.0.1:8910
```

## 閾値

ホストごとに、一番熱い thermal zone の**1分平均**で4段階に判定します：

| 一番熱い zone の1分平均 | 状態 |
|---|---|
| `< socNote` | 正常 |
| `>= socNote` | 注意 |
| `>= socWarn` | 高温 |
| `>= socHot` | 要対応 |

5分最大が `>= peak` になると**ピーク警告**を表示します。

**これらの閾値は運用上の目安であり、NVIDIA / Lenovo / ASUS の熱限界ではありません。** 24時間稼働の推論機で「早めに気づく」ための値であり、ベンダーの保証や安全境界ではありません。お使いの環境に合わせて `config.json` で調整してください。

## 位置づけ

フルクラスタ管理ツールと比べ、本プロジェクトは意図的に範囲を絞っています：

- 輸送手段は SSH のみ — ホスト側にエージェントを置かない
- ランタイム依存ゼロ（Node.js コアのみ）
- 1画面・スマホ優先
- 熱監視が第一、それ以外は第二

## ライセンス

MIT — [LICENSE](LICENSE) を参照。
