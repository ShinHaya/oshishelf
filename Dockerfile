# syntax=docker/dockerfile:1
FROM node:22.23.4-slim AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM node:22.23.4-slim AS build
WORKDIR /app
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ARG GOOGLE_CLOUD_PROJECT
ENV GOOGLE_CLOUD_PROJECT=$GOOGLE_CLOUD_PROJECT
ARG NEXT_PUBLIC_FIREBASE_API_KEY
ARG NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
ARG NEXT_PUBLIC_FIREBASE_PROJECT_ID
ARG NEXT_PUBLIC_FIREBASE_APP_ID
ENV NEXT_PUBLIC_FIREBASE_API_KEY=$NEXT_PUBLIC_FIREBASE_API_KEY \
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=$NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN \
    NEXT_PUBLIC_FIREBASE_PROJECT_ID=$NEXT_PUBLIC_FIREBASE_PROJECT_ID \
    NEXT_PUBLIC_FIREBASE_APP_ID=$NEXT_PUBLIC_FIREBASE_APP_ID
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

FROM node:22.23.4-slim AS run
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=8080 HOSTNAME=0.0.0.0
RUN useradd --system --uid 1001 nextjs
COPY --from=build --chown=nextjs /app/.next/standalone ./
COPY --from=build --chown=nextjs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs /app/public ./public
USER nextjs
EXPOSE 8080
CMD ["node", "server.js"]
