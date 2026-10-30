# Railway (or any container host). Mount a volume at /data so sessions and catalogues survive deploys.
FROM oven/bun:1.4.4-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
ENV STALLSNAP_DATA_DIR=/data
EXPOSE 3000
CMD ["bun", "src/server.ts"]
