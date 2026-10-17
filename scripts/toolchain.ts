// The pinned-toolchain check shared by check:proofs and the test lanes:
// the Bend checkout is at the pinned commit and unmodified, and the BendTT
// kernel (needed by --verdict) is built from that checkout's bendtt.lean.
// Throws when anything is missing; nothing falls back or is skipped.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const TC = path.join(ROOT, ".toolchain");

export const pin = (k: string) =>
  new RegExp(`^${k}=(.+)$`, "m").exec(
    fs.readFileSync(path.join(ROOT, "toolchain.env"), "utf8"),
  )?.[1];

export function checkPinnedToolchain(): string {
  const head = spawnSync("git", ["-C", path.join(TC, "bend"), "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).stdout?.trim();

  const dirty = spawnSync("git", ["-C", path.join(TC, "bend"), "status", "--porcelain"], {
    encoding: "utf8",
  }).stdout?.trim();

  if (head !== pin("BEND_COMMIT"))
    throw new Error(
      `bend checkout at ${head}, pinned ${pin("BEND_COMMIT")} (run scripts/bootstrap.sh)`,
    );

  if (dirty) throw new Error(`bend checkout is modified:\n${dirty}`);
  const kernel = path.join(TC, "bendtt", "bendtt");

  if (!fs.existsSync(kernel)) throw new Error("BendTT kernel not built (run scripts/bootstrap.sh)");

  const same = fs
    .readFileSync(path.join(TC, "bendtt", "bendtt.lean"))
    .equals(fs.readFileSync(path.join(TC, "bend", "bend2", "bendtt.lean")));

  if (!same) throw new Error("kernel built from a different bendtt.lean");

  return `bend ${head}; kernel from bend2/bendtt.lean with lean ${pin("LEAN_VERSION")}`;
}
