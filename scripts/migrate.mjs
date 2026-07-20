import { spawnSync } from "node:child_process";

if (!process.env.DATABASE_URL) {
  console.warn("DATABASE_URL is not configured; skipping Geeks Service database migration.");
  process.exit(0);
}

const command = process.platform === "win32" ? "npx.cmd" : "npx";
const result = spawnSync(command, ["prisma", "migrate", "deploy"], { stdio: "inherit" });
process.exit(result.status ?? 1);
