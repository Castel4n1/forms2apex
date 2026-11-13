import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// O .env fica na raiz do monorepo (o mesmo do Docker); o Next só leria apps/web/.env.
const rootEnv = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

/** @type {import('next').NextConfig} */
export default {
  transpilePackages: ["@forms2apex/core"],
  serverExternalPackages: ["@anthropic-ai/sdk"],
  poweredByHeader: false,
};
