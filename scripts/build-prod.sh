#!/bin/bash
set -e

echo "→ Switching to production (PostgreSQL) schema..."
cp prisma/schema.prod.prisma prisma/schema.prisma

echo "→ Installing dependencies..."
npm install

echo "→ Generating Prisma client..."
npx prisma generate

echo "→ Building app..."
npm run build

echo "✓ Build complete"
