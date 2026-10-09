FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY . .
RUN npm ci --ignore-scripts --workspace=@t-agnet/server --workspace=@t-agnet/agent --include-workspace-root
RUN npm run build --workspace=@t-agnet/server
FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/migrations ./server/migrations
COPY --from=build /app/server/openapi.json ./server/openapi.json
COPY --from=build /app/server/scripts/wait.mjs ./server/scripts/wait.mjs
COPY --from=build /app/server/package.json ./server/package.json
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8000
CMD ["node", "server/dist/main.mjs"]
