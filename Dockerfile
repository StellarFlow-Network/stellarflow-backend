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

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health/liveness').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Start the app directly - avoids needing package.json in final image
CMD ["node", "dist/index.js"]


# ==========================================
# Stage 1: Builder
# ==========================================
FROM python:3.11-slim AS builder

# Prevent Python from writing .pyc files & buffer stdout/stderr
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Install build dependencies required for compiling C extensions
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    g++ \
    build-essential \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies into a dedicated wheels directory or virtual environment
COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

# ==========================================
# Stage 2: Runtime (Production Layer)
# ==========================================
FROM python:3.11-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/install/bin:$PATH" \
    PYTHONPATH="/install/lib/python3.11/site-packages:$PYTHONPATH"

WORKDIR /app

# Install runtime-only C dynamic libraries (without compilers/toolchains)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq5 \
    && rm -rf /var/lib/apt/lists/*

# Copy pre-built packages from builder stage
COPY --from=builder /install /install

# Copy application source code
COPY . .

# Create and switch to non-root app user for container security hardening
RUN adduser --disabled-password --gecos "" appuser && \
    chown -R appuser:appuser /app
USER appuser

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]