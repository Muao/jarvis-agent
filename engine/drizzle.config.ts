import { defineConfig } from 'drizzle-kit';

// Migrations are generated and applied with drizzle-kit, never `push` (ADR-0010). The URL is only
// needed by commands that connect (`migrate`); `generate` works offline.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/infrastructure/db/schema.ts',
  out: './drizzle',
  ...(process.env['DATABASE_URL'] ? { dbCredentials: { url: process.env['DATABASE_URL'] } } : {}),
});
