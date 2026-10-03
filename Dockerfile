# Builds and runs only the backend (server/). The frontend (client/) deploys
# separately to Vercel as a static site -- see README. This image needs no
# volume: durable state lives in Postgres (Supabase), not on local disk.
FROM node:20-slim AS build
WORKDIR /app
COPY package.json ./
COPY server/package.json server/package.json
COPY client/package.json client/package.json
RUN npm install --workspace=server
COPY server server
RUN npm run build -w server

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/server/package.json server/package.json
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/node_modules node_modules
EXPOSE 8080
CMD ["node", "server/dist/index.js"]
