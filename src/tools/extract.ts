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
 * (`extract` + `ext2spice lvs`). With a PDK configured
 * (MCP_GDS_PDK_ROOT pointing at a volare version dir), extraction runs
 * under the real technology via `-rcfile`; otherwise generic.
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
    ? `gds read ${options.source}\nload ${options.cell ?? "TOP"}\nextract do local\nextract all\next2spice lvs\next2spice\nquit -noprompt\n`
    : `load ${options.source}\n${options.cell ? `select cell ${options.cell}\n` : ""}extract do local\nextract all\next2spice lvs\next2spice\nquit -noprompt\n`;

  // Tech resolution: explicit .magicrc paths pass through untouched (must
  // be container-visible). Otherwise default to the mounted PDK tech when a
  // PDK is configured, else run generic (flow plumbing only). PDK rc files
  // resolve $PDK_ROOT relatively, so export it pointing at the mount.
  const tech = options.techFile ?? (runner.getPdkDir() ? "sky130A" : "");
  const pdkTechRc = "/pdk/sky130A/libs.tech/magic/sky130A.magicrc";
  const techFlag: string[] =
    tech === "sky130A" ? ["-rcfile", pdkTechRc] : tech ? ["-T", tech] : [];
  const extraEnv = tech === "sky130A" ? { PDK_ROOT: "/pdk" } : undefined;
  const scriptPath = path.join(base, scriptName);
  // Snapshot pre-existing .spice files: magic exits 0 even when the load
  // fails, so only a file created BY this run counts as success.
  const before = new Set<string>();
  try {
    for (const name of await fs.readdir(base)) {
      if (name.endsWith(".spice")) before.add(name);
    }
  } catch {
    // unreadable cwd surfaces below
  }
  try {
    await fs.writeFile(scriptPath, script, "utf-8");
    const magicArgs = [...techFlag, "-dnull", "-noconsole", scriptName];
    const res = await runner.execute("magic", magicArgs, {
      cwd: base,
      timeoutMs: options.timeoutMs ?? 120000,
      ...(extraEnv ? { env: extraEnv } : {}),
    });

    const combined = `${res.stdout}\n${res.stderr}`;
    // Magic exits 0 even when the load fails ("No such file", "nothing
    // here to extract") and still writes stub SPICE. Fail fast on those
    // markers: artifact presence alone proves nothing (same lesson as
    // DEF-existence guards).
    const loadFailure = combined
      .split("\n")
      .map((l) => l.trim())
      .find((l) => /no such file|cannot open|nothing here to extract|no cells? (found|extracted)/i.test(l));
    if (loadFailure) {
      // Magic may still have written a stub <source-stem>.spice; remove it.
      const stem = path.basename(options.source).replace(/\.(mag|gds|oas)$/i, "");
      await fs.rm(path.join(base, `${stem}.spice`), { force: true });
      return { ...fail([`Magic could not load the source layout: ${loadFailure.slice(0, 200)}`]) };
    }
    // Bare ext2spice writes <cell>.spice (a filename argument would be
    // taken as a cell name); adopt the freshest NEW output for the caller.
    let produced: string | null = null;
    try {
      const names = await fs.readdir(base);
      let best = -1;
      for (const name of names) {
        if (!name.endsWith(".spice") || before.has(name)) continue;
        const st = await fs.stat(path.join(base, name));
        if (st.mtimeMs > best) {
          best = st.mtimeMs;
          produced = name;
        }
      }
    } catch {
      produced = null;
    }

    if (res.exitCode !== 0 || !produced) {
      const tail = combined.split("\n").map((l) => l.trim()).filter(Boolean).slice(-6);
      return { ...fail([`Magic extraction failed (exit ${res.exitCode}).`, ...tail]) };
    }
    if (produced !== out) {
      await fs.rename(path.join(base, produced), path.join(base, out));
    }
    // A stub without any subcircuit is not an extraction (see above).
    const body = await fs.readFile(path.join(base, out), "utf-8").catch(() => "");
    if (!/^\s*\.subckt/im.test(body)) {
      await fs.rm(path.join(base, out), { force: true });
      return { ...fail(["Extracted SPICE contains no subcircuit; the source cell is likely missing or empty."]) };
    }

    const stats = parseExtStats(combined);
    const warnings =
      tech === "sky130A"
        ? []
        : [
            "Extracted with the container's generic technology; device-accurate results need a PDK tech file.",
          ];
    return {
      success: true, source: options.source, spiceFile: out,
      ...stats,
      warnings,
      errors: [],
    };
  } finally {
    await fs.rm(scriptPath, { force: true });
  }
}
