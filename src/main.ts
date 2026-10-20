// ─── main entry (split from bin/cc-launch.mjs) ──────────────────────────

import { dispatch } from "./commands/dispatch.js";

async function main() {
  await dispatch(process.argv.slice(2));
}

export {
  isVoltaManagedInstall,
  queryLatestVersion,
  readInstalledVersion,
  reportUpdateOutcome,
  runUpdate,
} from "./commands/update.js";
export { main };
