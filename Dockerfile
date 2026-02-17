FROM mcr.microsoft.com/playwright:v1.58.2-jammy

# アプリケーションディレクトリを作成
WORKDIR /app

# 依存関係をコピーしてインストール
COPY package*.json ./
RUN npm install

# アプリケーションのソースコードをコピー
COPY . .

# 必要なシステムパッケージのインストール (念のためxvfbも入れておくが起動は速くする)
RUN apt-get update && apt-get install -y xvfb && rm -rf /var/lib/apt/lists/*

# 実行中のディレクトリ権限を確保
RUN mkdir -p /app/user_data && chmod -R 777 /app/user_data

# 環境変数の設定
ENV HEADLESS=true
ENV DEBIAN_FRONTEND=noninteractive
ENV PORT=10000

# スクレイパー起動
# xvfb-runを使わずに最短で起動を試みる (headless: trueを強制しているため)
CMD ["node", "index.js"]
