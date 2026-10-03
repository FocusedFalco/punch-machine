FROM node:20-slim AS build
WORKDIR /app
COPY package.json ./
COPY server/package.json server/package.json
COPY client/package.json client/package.json
RUN npm install
COPY . .
RUN npm run build

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/server/package.json server/package.json
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/node_modules server/node_modules
COPY --from=build /app/client/dist client/dist
ENV CLIENT_DIST=/app/client/dist
EXPOSE 8080
VOLUME ["/app/data"]
ENV DB_PATH=/app/data/outtime.db
CMD ["node", "server/dist/index.js"]
