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

WORKDIR /app

# Install system dependencies required for building packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

# Create virtual environment and install dependencies
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY requirements.txt* pyproject.toml* ./
RUN pip install --no-cache-dir --upgrade pip && \
    if [ -f requirements.txt ]; then pip install --no-cache-dir -r requirements.txt; fi

# Stage 2: Production runtime image
FROM python:3.11-slim AS runtime

WORKDIR /app

# Install runtime-only C dynamic libraries (without compilers/toolchains)
# libpango/libharfbuzz/libjpeg/zlib are required by WeasyPrint (Issue #772)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq5 \
    libpango-1.0-0 \
    libpangoft2-1.0-0 \
    libharfbuzz0b \
    libjpeg62-turbo \
    zlib1g \
    liblcms2-2 \
    libffi8 \
    && rm -rf /var/lib/apt/lists/*

# Copy virtual environment from builder stage
COPY --from=builder /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Copy application source code
COPY . /app

EXPOSE 8000 3000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
