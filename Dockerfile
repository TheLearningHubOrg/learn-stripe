# Production Dockerfile for the Learn Stripe companion service
# Stage 1 installs dev dependencies, type-checks, runs the test suite
# (offline, test-mode fixtures only) and compiles TypeScript.
FROM node:24-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY tests ./tests

RUN npm run typecheck && npm test && npm run build

# Stage 2 ships only production dependencies and the compiled output.
FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist

# Secrets (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET) are injected at runtime, never baked in.
EXPOSE 4242
USER node
CMD ["node", "dist/index.js"]
