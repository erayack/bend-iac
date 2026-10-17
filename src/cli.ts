#!/usr/bin/env bun
// bend-iac: plan Cloudflare Worker + D1 declarations with a Bend planner
// whose safety laws are mechanically checked. `plan <dir>` plans a fixture
// and never calls a cloud API. `init` and `plan|apply|destroy --env` deploy
// an app project's environments (src/project); `live` runs disposable e2e
// runs (src/live). Both deploy through the same Wrangler-backed executor.

import * as fs from "node:fs";
import * as path from "node:path";
import { decode, encode } from "./codec";
import { build, EngineError, load } from "./engine";
import { render, report } from "./format";
import { decodeUtf8, NoInputError, readBytes, UsageError } from "./input";
import { live, LiveError } from "./live/live";
import { projectApply, projectDestroy, projectInit, projectPlan } from "./project/project";
import { WranglerError } from "./live/wrangler";
import {
  InputError,
  parseApprovals,
  parseDesired,
  parseGrant,
  parseObserved,
  type Approval,
} from "./schema";

export const EXIT = {
  approved: 0,
  rejected: 2,
  approvalRequired: 3,
  usage: 64,
  input: 65,
  noInput: 66,
  engine: 70,
} as const;

const HELP = `bend-iac: proof-oriented infrastructure as code

Usage:
  bend-iac plan <dir> [--json]
  bend-iac plan --desired <file> --observed <file> --grant <file> [--approvals <file>] [--json]

  bend-iac init [<dir>] --project <name> --env <environment> --account <id>
  bend-iac plan    --env <environment> --account <id> [--project <dir>] [--json]
  bend-iac apply   --env <environment> --account <id> --digest sha256:<hex>
                   [--artifact <file>] [--project <dir>] [--json]
  bend-iac destroy --env <environment> --account <id> --confirm <project>/<environment>
                   [--approvals <file>] [--project <dir>]

  bend-iac live ...       disposable e2e runs (see bend-iac live help)
  bend-iac build          check the proofs, then compile core/planner.bend
  bend-iac help           show this help
  bend-iac version        show versions and pins

A <dir> holds desired.json, observed.json, grant.json and, optionally,
approvals.json; a flag overrides one of them. plan with --env plans the
project in --project <dir> or the current directory (bend-iac.json) against
the environment's live state. Fixture planning (without --env) never contacts
Cloudflare and has no apply/destroy step: its plans are never executed.

The planner (Bend, core/planner.bend) diffs the desired graph against the
observed fixture and returns one of:
  approved           an ordered plan whose every step the grant allows and
                     whose destructive steps on protected databases are
                     approved (LAWS.bend); may be empty (no changes)
  approval_required  only approvals are missing; nothing may run
  rejected           invalid graph, grant violation or stale approval;
                     nothing may run

Exit codes:
  0   approved (including no changes)
  2   rejected
  3   approval required
  64  usage error
  65  invalid input (malformed JSON, unknown field or value, limits)
  66  input file missing or unreadable
  70  engine error (toolchain missing, proofs fail, build failed)

Project commands also exit 1 (a remote step failed), 4 (unsupported by
the adapter), 5 (refused: digest, artifact, state identity, confirmation or
held lock), 69 (remote state undetermined) and 130 (interrupted).
See docs/projects.md.
`;

type Files = { desired?: string; observed?: string; grant?: string; approvals?: string };

type PlanArgs = { files: Files; json: boolean };

const FILE_FLAGS: ReadonlyMap<string, keyof Files> = new Map([
  ["--desired", "desired"],
  ["--observed", "observed"],
  ["--grant", "grant"],
  ["--approvals", "approvals"],
] as const);

function parseArgs(argv: string[]): PlanArgs {
  const files: Files = {};
  let json = false;
  let dir: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const k = FILE_FLAGS.get(a);

    if (a === "--json") {
      json = true;
    } else if (k !== undefined) {
      const v = argv[++i];

      if (v === undefined || v.startsWith("--")) throw new UsageError(`${a} needs a file`);

      if (files[k] !== undefined) throw new UsageError(`${a} given twice`);
      files[k] = v;
    } else if (a.startsWith("-")) {
      throw new UsageError(`unknown option ${a}`);
    } else if (dir === undefined) {
      dir = a;
    } else {
      throw new UsageError(`unexpected argument ${a}`);
    }
  }

  if (dir !== undefined) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory())
      throw new NoInputError(`${dir}: not a directory`);
    files.desired ??= path.join(dir, "desired.json");
    files.observed ??= path.join(dir, "observed.json");
    files.grant ??= path.join(dir, "grant.json");

    if (files.approvals === undefined && fs.existsSync(path.join(dir, "approvals.json"))) {
      files.approvals = path.join(dir, "approvals.json");
    }
  }

  for (const k of ["desired", "observed", "grant"] as const) {
    if (files[k] === undefined) throw new UsageError(`missing --${k} (or a <dir>)`);
  }

  return { files, json };
}

async function plan(argv: string[]): Promise<number> {
  const { files, json } = parseArgs(argv);
  const desBytes = readBytes(files.desired!);
  const obsBytes = readBytes(files.observed!);
  const grantBytes = readBytes(files.grant!);
  const appsBytes = files.approvals ? readBytes(files.approvals) : null;
  let des, obs, grant, apps: Approval[];

  try {
    des = parseDesired(decodeUtf8("desired", desBytes));
    obs = parseObserved(decodeUtf8("observed", obsBytes), des.environments);
    grant = parseGrant(decodeUtf8("grant", grantBytes), des.environments);
    apps =
      appsBytes === null
        ? []
        : parseApprovals(decodeUtf8("approvals", appsBytes), des.environments);
  } catch (e) {
    if (e instanceof InputError && json) {
      process.stdout.write(
        JSON.stringify(
          {
            outcome: "invalid_input",
            executable: false,
            error: { document: e.doc, at: e.where, detail: e.detail },
          },
          null,
          2,
        ) + "\n",
      );
    }

    throw e;
  }

  const planner = await load();
  const enc = encode(des, obs, grant, apps);
  const raw = planner.plan(...enc.args);
  const out = decode(raw, enc.tables);
  const rep = report(out, des, obs, grant, apps, planner.stamp);
  process.stdout.write(json ? JSON.stringify(rep, null, 2) + "\n" : render(rep, des, obs, apps));

  return out.outcome === "approved"
    ? EXIT.approved
    : out.outcome === "approval_required"
      ? EXIT.approvalRequired
      : EXIT.rejected;
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;

  try {
    switch (cmd) {
      case "plan":
        // --env selects the project workflow; without it, fixture planning
        return rest.includes("--env") ? await projectPlan(rest) : await plan(rest);
      case "init":
        return await projectInit(rest);
      case "apply":
        return await projectApply(rest);
      case "destroy":
        return await projectDestroy(rest);
      case "live":
        return await live(rest);
      case "build":
        build((s) => process.stdout.write(s + "\n"));

        return 0;
      case "help":
      case "--help":
      case "-h":
        process.stdout.write(HELP);

        return 0;
      case "version":
      case "--version": {
        const { bendCommit } = await import("./engine");
        process.stdout.write(`bend-iac 0.1.0 (bend ${bendCommit()}, bun ${Bun.version})\n`);

        return 0;
      }

      case undefined:
        process.stderr.write(HELP);

        return EXIT.usage;
      default:
        throw new UsageError(`unknown command "${cmd}"`);
    }
  } catch (e) {
    const say = (code: string, msg: string) =>
      process.stderr.write(`bend-iac: error[${code}]: ${msg}\n`);

    if (e instanceof UsageError) {
      say("usage", `${e.message} (see bend-iac help)`);

      return EXIT.usage;
    }

    if (e instanceof NoInputError) {
      say("no-input", e.message);

      return EXIT.noInput;
    }

    if (e instanceof InputError) {
      say("invalid-input", e.message);

      return EXIT.input;
    }

    if (e instanceof LiveError) {
      say("live", e.message);

      return e.exit;
    }

    if (e instanceof WranglerError) {
      say("live", `remote state not determined: ${e.message}`);

      return 69;
    }

    if (e instanceof EngineError) {
      say("engine", e.message);

      return EXIT.engine;
    }

    say("engine", `unexpected failure: ${e instanceof Error ? e.message : String(e)}`);

    return EXIT.engine;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
