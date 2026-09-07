import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ToolRunner } from "../runner.js";
import { ExtractResult } from "../parsers/types.js";

export interface ExtractOptions {
  source: string;
  outputSpice?: string;
  cell?: string;
  techFile?: string;
  cwd?: string;
  timeoutMs?: number;
}

export function parseExtStats(log: string): { devices?: number; nets?: number } {
  let devices: number | undefined;
  let nets: number | undefined;
  for (const line of log.split("\n")) {
    let m =
      line.match(/(\d+)\s+devices? extracted/i) ||
      line.match(/extracted\s+(\d+)\s+devices?/i) ||
      line.match(/(\d+)\s+devices?\b/i);
    if (m) devices = parseInt(m[1], 10);
    m =
      line.match(/(\d+)\s+nets? extracted/i) ||
      line.match(/extracted\s+(\d+)\s+nets?/i) ||
      line.match(/and\s+(\d+)\s+nets?\b/i);
    if (m) nets = parseInt(m[1], 10);
  }
  const out: { devices?: number; nets?: number } = {};
  if (devices !== undefined) out.devices = devices;
  if (nets !== undefined) out.nets = nets;
  return out;
}

/**
 * Extracts a SPICE netlist from layout with Magic batch mode
 * (`extract` + `ext2spice lvs`). Runs on the container's generic
 * technology: correct flow plumbing, but device-accurate extraction
 * needs a PDK tech file (not baked into the image yet).
 */
export async function runExtract(
  runner: ToolRunner,
  options: ExtractOptions
): Promise<ExtractResult> {
  const fail = (errors: string[]): ExtractResult => ({
    success: false, source: options.source, warnings: [], errors,
  });

  if (!options.source) return fail(["No source layout specified."]);

  const base = path.resolve(options.cwd || process.cwd());
  const out = options.outputSpice || options.source.replace(/\.(mag|gds|oas)$/i, "") + "_extracted.spice";
  const scriptName = `.mag_extract_tmp_${Date.now()}.tcl`;
  const isGds = /\.(gds|oas)$/i.test(options.source);

  const script = isGds
    ? `gds read ${options.source}\nload ${options.cell ?? "TOP"}\nextract all\next2spice lvs\next2spice ${out}\nquit -noprompt\n`
    : `load ${options.source}\n${options.cell ? `select cell ${options.cell}\n` : ""}extract all\next2spice lvs\next2spice ${out}\nquit -noprompt\n`;

  const scriptPath = path.join(base, scriptName);
  try {
    await fs.writeFile(scriptPath, script, "utf-8");
    const magicArgs = options.techFile
      ? ["-T", options.techFile, "-dnull", "-noconsole", scriptName]
      : ["-dnull", "-noconsole", scriptName];
    const res = await runner.execute("magic", magicArgs, {
      cwd: base,
      timeoutMs: options.timeoutMs ?? 120000,
    });

    const combined = `${res.stdout}\n${res.stderr}`;
    let exists = false;
    try {
      await fs.access(path.join(base, out));
      exists = true;
    } catch {
      exists = false;
    }

    if (res.exitCode !== 0 || !exists) {
      const tail = combined.split("\n").map((l) => l.trim()).filter(Boolean).slice(-6);
      return { ...fail([`Magic extraction failed (exit ${res.exitCode}).`, ...tail]) };
    }

    const stats = parseExtStats(combined);
    return {
      success: true, source: options.source, spiceFile: out,
      ...stats,
      warnings: [
        "Extracted with the container's generic technology; device-accurate results need a PDK tech file.",
      ],
      errors: [],
    };
  } finally {
    await fs.rm(scriptPath, { force: true });
  }
}
