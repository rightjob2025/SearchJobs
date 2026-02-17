FROM mcr.microsoft.com/playwright:v1.58.2-jammy

# アプリケーションディレクトリを作成
WORKDIR /app

# 依存関係をコピーしてインストール
COPY package*.json ./
RUN npm install

# アプリケーションのソースコードをコピー
COPY . .

# 必要なシステムパッケージのインストール (xvfb, dbus)
RUN apt-get update && apt-get install -y \
    xvfb \
    dbus-x11 \
    && rm -rf /var/lib/apt/lists/*

# 実行中のディレクトリ権限を確保
RUN mkdir -p /app/user_data && chmod -R 777 /app/user_data

# 実行ポートの指定
EXPOSE 3001

# 環境変数の設定 (Playwrightにヘッドレスを強制するためのバックアップ)
ENV HEADLESS=true
ENV DEBIAN_FRONTEND=noninteractive

# スクレイパー起動
# xvfb-run を使用し、さらに DBUS の警告を回避するために設定を追加
CMD ["xvfb-run", "--auto-servernum", "--server-args=-screen 0 1280x800x24", "node", "index.js"]
