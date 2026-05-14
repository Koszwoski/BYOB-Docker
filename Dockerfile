FROM node:20-alpine

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm && pnpm install --frozen-lockfile

COPY src/ ./src/

CMD ["node", "--max-old-space-size=256", "src/main.mjs"]
