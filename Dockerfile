# Builder stage: install all deps, generate Prisma client, build TypeScript, then prune dev deps
FROM node:20-alpine AS builder

WORKDIR /usr/src/app

# Install all dependencies (including devDependencies needed for build)
COPY package*.json ./
COPY package-lock.json ./
RUN npm ci

# Copy source and schema
COPY tsconfig.json ./
COPY prisma ./prisma
COPY src ./src

# Generate Prisma client and build
RUN npx prisma generate
RUN npm run build

# Remove devDependencies so node_modules contains only production packages
RUN npm prune --production

# Runner stage: only copy production node_modules and built dist
FROM node:20-alpine AS runner

WORKDIR /usr/src/app

ENV NODE_ENV=production
ENV PORT=3000

# Copy only the production node modules and the compiled output
COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY --from=builder /usr/src/app/dist ./dist

# Expose the API port
EXPOSE 3000

# Start the app directly - avoids needing package.json in final image
CMD ["node", "dist/index.js"]
