FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-lxml && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN npm ci || npm install
RUN npm run build
ENV NODE_ENV=production
EXPOSE 3000
USER node
WORKDIR /app/apps/web
CMD ["npx", "next", "start", "-p", "3000"]
