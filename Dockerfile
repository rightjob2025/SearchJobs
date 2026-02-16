FROM mcr.microsoft.com/playwright:v1.58.2-jammy

# アプリケーションディレクトリを作成
WORKDIR /app

# 依存関係をコピーしてインストール
COPY package*.json ./
RUN npm install

# アプリケーションのソースコードをコピー
COPY . .

# 実行ポートの指定
EXPOSE 3001

# スクレイパー起動
CMD ["node", "index.js"]
