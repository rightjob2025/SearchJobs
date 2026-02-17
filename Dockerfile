FROM mcr.microsoft.com/playwright:v1.58.2-jammy

# アプリケーションディレクトリを作成
WORKDIR /app

# 依存関係をコピーしてインストール
COPY package*.json ./
RUN npm install

# アプリケーションのソースコードをコピー
COPY . .

# 必要なシステムパッケージのインストール (xvfb)
RUN apt-get update && apt-get install -y xvfb && rm -rf /var/lib/apt/lists/*

# 実行中のディレクトリ権限を確保
RUN mkdir -p /app/user_data && chmod -R 777 /app/user_data

# 環境変数の設定
ENV HEADLESS=true
ENV DEBIAN_FRONTEND=noninteractive

# スクレイパー起動
# Renderの期待するポートスキャンに早く応答するため、xvfb-run のパラメータを調整
CMD ["xvfb-run", "--auto-servernum", "node", "index.js"]
