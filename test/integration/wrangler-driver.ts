// Driver for wrangler-process.test.ts: runs one real `npx --yes
// wrangler@4.151.1 --version` through the adapter with the given short
// timeouts, prints the result, then stays alive for <linger-ms> (as a live
// command doing more reads would), so that a signal sent after the command
// closed would be journaled while it is still running. `--version` contacts
// no Cloudflare API and reads no credentials; the account id is made up.
//
//   bun wrangler-driver.ts <state-dir> <timeout-ms> <grace-ms> <settle-ms> <linger-ms>
import { build, Wrangler } from "../../src/live/wrangler";

const [dir, timeoutMs, graceMs, settleMs, lingerMs] = process.argv.slice(2).map(String);
const ACCOUNT = "0123456789abcdef0123456789abcdef";

const w = new Wrangler(dir, ACCOUNT, () => {}, {
  timeoutMs: Number(timeoutMs),
  graceMs: Number(graceMs),
  settleMs: Number(settleMs),
});

const r = await w.run("version", ["--version"], build.base(ACCOUNT));
const result = { code: r.code, signal: r.signal, timedOut: r.timedOut, ms: r.ms };

process.stdout.write(JSON.stringify(result) + "\n");

await Bun.sleep(Number(lingerMs));
