#!/bin/sh
set -e

# Grant schema permissions (PostgreSQL 15+ no longer auto-grants CREATE on public)
printf 'GRANT ALL ON SCHEMA public TO CURRENT_USER;\n' | npx prisma db execute --url "$DATABASE_URL" --stdin || true

# Push schema (idempotent)
npx prisma db push --skip-generate

exec npm run start
