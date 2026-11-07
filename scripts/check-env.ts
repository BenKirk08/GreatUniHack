import "./lib/load-env";
import { serverEnv } from "../lib/env";

const env = serverEnv();
const unset = (Object.keys(env) as (keyof typeof env)[]).filter((k) => env[k] === undefined);
console.log(`Environment OK (${Object.keys(env).length} keys). Not yet set: ${unset.join(", ") || "none"}`);
