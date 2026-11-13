// Runs every release gate in order and stops at the first failure. Each step
// is an npm script so it keeps the npm context the gates rely on.
import { spawnSync } from "node:child_process";

const steps = [
  "verify",
  "package:smoke",
  "bench:check",
  "pm:check",
  "sweep:historical",
];

const npm = process.env.npm_execpath;
if (!npm) throw new Error("run this through `npm run release:check`");

for (const step of steps) {
  console.log(`\n=== npm run ${step}`);
  const { status } = spawnSync(process.execPath, [npm, "run", step], {
    stdio: "inherit",
  });
  if (status !== 0) {
    console.error(`\nrelease:check failed at ${step}`);
    process.exit(status ?? 1);
  }
}
console.log("\nrelease:check passed");
