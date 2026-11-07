/**
 * Record PUBLIC_BASE_URL — the stable production domain https://<project>.vercel.app, never a per-deployment
 * URL — in .env.local and on Vercel.  npx tsx scripts/set-public-url.ts [https://granny-agent.vercel.app]
 */
import "./lib/load-env";
import { getVercelProject, upsertVercelEnv, writeLocalEnv } from "./lib/vercel";

async function main() {
  const token = process.env.VERCEL_TOKEN;
  if (!token) throw new Error("VERCEL_TOKEN is not set");
  let url = process.argv[2];
  if (!url) {
    const project = await getVercelProject(token);
    const aliases = project.targets?.production?.alias ?? [];
    const stable = aliases.find((a) => a === `${project.name}.vercel.app`) ?? aliases.find((a) => a.endsWith(".vercel.app"));
    if (!stable) throw new Error(`No production alias yet (deploy with --prod first). Aliases: ${aliases.join(", ")}`);
    url = `https://${stable}`;
  }
  url = url.replace(/\/$/, "");
  if (!/^https:\/\/[a-z0-9.-]+$/.test(url)) throw new Error(`Not a bare https origin: ${url}`);
  writeLocalEnv("PUBLIC_BASE_URL", url);
  await upsertVercelEnv({ PUBLIC_BASE_URL: url }, { token });
  console.log(`PUBLIC_BASE_URL=${url} written to .env.local and Vercel (redeploy to apply).`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
