#!/usr/bin/env node
// generate-vercel-json.mjs — Generates vercel.json with correct API rewrite URL.
// Reads VITE_API_SERVER_URL from env (set per Vercel project).
// Run before `vite build` in the build command.

import { writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const vercelJsonPath = join(__dirname, "..", "vercel.json");

const apiUrl = process.env.VITE_API_SERVER_URL
  || "https://tonys-command-center-api-server.vercel.app";

const config = {
  framework: "vite",
  installCommand: "cd ../.. && pnpm install --frozen-lockfile",
  buildCommand: "cd ../.. && pnpm --filter @workspace/tcc build",
  outputDirectory: "dist/public",
  rewrites: [
    {
      source: "/api/:path*",
      destination: `${apiUrl}/api/:path*`,
    },
  ],
};

writeFileSync(vercelJsonPath, JSON.stringify(config, null, 2) + "\n");
console.log(`[vercel.json] API rewrite → ${apiUrl}/api/:path*`);
