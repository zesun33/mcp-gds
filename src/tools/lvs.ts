import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ToolRunner } from "../runner.js";
import { LvsResult } from "../parsers/types.js";

export interface LvsOptions {
  schematicNetlist: string;
  schematicCell: string;
  layoutNetlist: string;
  layoutCell: string;
  setupFile?: string;
  logFile?: string;
  cwd?: string;
  timeoutMs?: number;
}

export function parseLvsLog(log: string): { match: boolean | null; netCount1?: number; netCount2?: number; deviceCount1?: number; deviceCount2?: number } {
  let match: boolean | null = null;
  if (/property errors/i.test(log)) match = false;
  else if (/(Circuits|Netlists) match (uniquely|exactly)/i.test(log)) match = true;
  else if (/do not match|mismatch|failed/i.test(log)) match = false;

  const nets: Array<[number, number]> = [];
  for (const line of log.split("\n")) {
    const m = line.match(/Number of nets:\s*(\d+)\s*\|\s*.*?(\d+)/);
    if (m) nets.push([parseInt(m[1], 10), parseInt(m[2], 10)]);
  }
  const devs: Array<[number, number]> = [];
  for (const line of log.split("\n")) {
    const m = line.match(/Number of devices:\s*(\d+)\s*\|\s*.*?(\d+)/);
    if (m) devs.push([parseInt(m[1], 10), parseInt(m[2], 10)]);
  }
  const last = <T>(a: T[]): T | undefined => (a.length > 0 ? a[a.length - 1] : undefined);
  const n = last(nets);
  const d = last(devs);

  return {
    match,
    ...(n ? { netCount1: n[0], netCount2: n[1] } : {}),
    ...(d ? { deviceCount1: d[0], deviceCount2: d[1] } : {}),
  };
}

/**
 * Compares two SPICE netlists with Netgen (`-batch lvs`, JSON sidecar).
 * Without a PDK setup file it compares structurally (`nosetup`); pass
 * setupFile for device-class mapping. This is netlist-vs-netlist LVS —
 * layout netlists come from `extract_magic`.
 */
export async function runLvs(
  runner: ToolRunner,
  options: LvsOptions
): Promise<LvsResult> {
  const fail = (errors: string[]): LvsResult => ({
    success: false, match: false,
    circuit1: `${options.schematicNetlist} ${options.schematicCell}`,
    circuit2: `${options.layoutNetlist} ${options.layoutCell}`,
    warnings: [], errors,
  });

  if (!options.schematicNetlist || !options.layoutNetlist) {
    return fail(["schematicNetlist and layoutNetlist are required."]);
  }

  const base = path.resolve(options.cwd || process.cwd());
  const ts = Date.now();
  const log = options.logFile || `.lvs_tmp_${ts}.log`;
  const setup = options.setupFile ?? "nosetup";

  // Debian/Ubuntu ship the batch binary off-PATH; upstream installs put
  // `netgen` on PATH. Try PATH first, fall back to the Debian location.
  // (The `netgen-lvs` wrapper needs a display and is unusable headless.)
  let res = await runner.execute(
    "netgen",
    [
      "-batch", "lvs",
      `${options.schematicNetlist} ${options.schematicCell}`,
      `${options.layoutNetlist} ${options.layoutCell}`,
      setup, log, "-json",
    ],
    { cwd: base, timeoutMs: options.timeoutMs ?? 120000 }
  );
  if (res.exitCode !== 0 && /executable file .* not found|Process spawn error|not found/i.test(`${res.stdout}\n${res.stderr}`)) {
    res = await runner.execute(
      "/usr/lib/netgen/bin/netgen",
      [
        "-batch", "lvs",
        `${options.schematicNetlist} ${options.schematicCell}`,
        `${options.layoutNetlist} ${options.layoutCell}`,
        setup, log, "-json",
      ],
      { cwd: base, timeoutMs: options.timeoutMs ?? 120000 }
    );
  }

  const combined = `${res.stdout}\n${res.stderr}`;
  let logText = combined;
  try {
    logText += "\n" + (await fs.readFile(path.join(base, log), "utf-8"));
  } catch {
    // fall back to console output only
  }

  const parsed = parseLvsLog(logText);

  // JSON sidecar (comp.json) mirrors the text log; keep going if absent.
  try {
    await fs.access(path.join(base, "comp.json"));
  } catch {
    // absent: text verdict stands
  }

  if (parsed.match === null) {
    const tail = combined.split("\n").map((l) => l.trim()).filter(Boolean).slice(-5);
    return {
      ...fail([`Netgen produced no clear match verdict (exit ${res.exitCode}).`, ...tail]),
      logFile: log,
    };
  }

  const result: LvsResult = {
    success: true,
    match: parsed.match,
    circuit1: `${options.schematicNetlist} ${options.schematicCell}`,
    circuit2: `${options.layoutNetlist} ${options.layoutCell}`,
    ...(parsed.netCount1 !== undefined ? { netCount1: parsed.netCount1, netCount2: parsed.netCount2 } : {}),
    ...(parsed.deviceCount1 !== undefined ? { deviceCount1: parsed.deviceCount1, deviceCount2: parsed.deviceCount2 } : {}),
    logFile: log,
    warnings: parsed.match ? [] : ["Circuits differ; inspect the log for net/device mismatches."],
    errors: [],
  };

  // Keep the workspace tidy unless the caller named the log explicitly.
  // NB: -json makes netgen derive a sidecar from the LOG name (<log>.json
  // with .log swapped), in addition to comp.json.
  if (!options.logFile) {
    await fs.rm(path.join(base, log), { force: true });
    await fs.rm(path.join(base, log.replace(/\.log$/, ".json")), { force: true });
    await fs.rm(path.join(base, "comp.json"), { force: true });
  }
  return result;
}
