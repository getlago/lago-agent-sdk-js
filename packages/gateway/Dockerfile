# Build from the repo root: docker build -f packages/gateway/Dockerfile .
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/agent-sdk/package.json packages/agent-sdk/
COPY packages/gateway/package.json packages/gateway/
RUN npm ci --ignore-scripts
COPY tsconfig.json* eslint.config.js* ./
COPY packages ./packages
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/agent-sdk/package.json packages/agent-sdk/
COPY --from=build /app/packages/agent-sdk/dist packages/agent-sdk/dist
COPY --from=build /app/packages/gateway/package.json packages/gateway/
COPY --from=build /app/packages/gateway/dist packages/gateway/dist
COPY --from=build /app/packages/gateway/bin packages/gateway/bin
EXPOSE 8090
CMD ["node", "packages/gateway/bin/gateway.mjs"]
