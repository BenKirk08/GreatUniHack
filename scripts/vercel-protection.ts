/**
 * Show the linked Vercel project's deployment protection and production aliases.
 * ElevenLabs must be able to reach /api/tools/* and /api/webhooks/* on the production domain without a
 * Vercel login; with the default "all_except_custom_domains" protection the <project>.vercel.app production
 * alias is reachable (verified), while per-deployment URLs are not. See SETUP.md if that ever changes.
 *   npx tsx scripts/vercel-protection.ts
 */
import "./lib/load-env";
import { getVercelProject } from "./lib/vercel";

async function main() {
  const token = process.env.VERCEL_TOKEN;
  if (!token) throw new Error("VERCEL_TOKEN is not set");
  const p = await getVercelProject(token);
  console.log(`project ${p.name}: ssoProtection=${JSON.stringify(p.ssoProtection)} passwordProtection=${JSON.stringify(p.passwordProtection)}`);
  console.log(`production aliases: ${JSON.stringify(p.targets?.production?.alias ?? [])}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
