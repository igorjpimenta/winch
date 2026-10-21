import { defineConfig } from "drizzle-kit";
import { resolveDbPath } from "./src/paths.js";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema.js",
  out: "./.migrations",
  dbCredentials: { url: process.env.WINCH_DB || resolveDbPath() },
});
