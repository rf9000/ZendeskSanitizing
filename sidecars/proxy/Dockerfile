FROM oven/bun:1.3.9-slim
# The upstream Zendesk MCP server is a Node package (`npx -y @sshadows/zendesk-mcp-server`);
# the base bun image does not ship node/npm, so install both, then pre-install the pinned
# upstream globally to avoid a runtime npm download and pin its version in the image.
RUN apt-get update && apt-get install -y --no-install-recommends nodejs npm \
    && npm install -g @sshadows/zendesk-mcp-server@1.4.1 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY config ./config
ENV ZSAN_TRANSPORT=http
EXPOSE 8080
CMD ["bun", "run", "src/server/stdio.ts"]
