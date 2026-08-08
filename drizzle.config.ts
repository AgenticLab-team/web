import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/lib/db/schema/index.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DB_PATH ?? "./data/agenticlab.db",
  },
  strict: true,
  verbose: true,
});
