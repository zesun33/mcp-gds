import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ToolRunner } from "../runner.js";
import { streamOutScript } from "../scripts.js";
import { StreamOutResult } from "../parsers/types.js";

export const NANGATE_TECH_LEF = "/opt/platforms/nangate45/NangateOpenCellLibrary.tech.lef";
export const NANGATE_MACRO_LEF = "/opt/platforms/nangate45/NangateOpenCellLibrary.macro.lef";

/**
 * Streams a DEF layout to GDSII via headless KLayout (abstract-level:
 * standard-cell footprints from LEF; full transistor GDS needs the PDK).
 * Use for handoff previews and KLayout DRC input, not tapeout signoff.
 */
export async function runStreamOut(
  runner: ToolRunner,
  defFile: string,
  outGds?: string,
  techLef: string = NANGATE_TECH_LEF,
  macroLef: string = NANGATE_MACRO_LEF,
  cwd?: string
): Promise<StreamOutResult> {
  const fail = (errors: string[]): StreamOutResult => ({
    success: false, defFile, warnings: [], errors,
  });

  if (!defFile) return fail(["No DEF file specified."]);

  const base = path.resolve(cwd || process.cwd());
  const out = outGds || defFile.replace(/\.def$/i, "") + ".gds";
  const scriptName = `.gds_stream_tmp_${Date.now()}.py`;
  const scriptPath = path.join(base, scriptName);

  try {
    await fs.writeFile(scriptPath, streamOutScript(defFile, techLef, macroLef, out), "utf-8");
    const res = await runner.execute("klayout", ["-b", "-z", "-r", scriptName], {
      cwd: base,
      timeoutMs: 120000,
    });

    let cellsWritten: number | undefined;
    for (const line of res.stdout.split("\n")) {
      const m = line.match(/STREAM_CELLS:(\d+)/);
      if (m) cellsWritten = parseInt(m[1], 10);
    }
    const wrote = res.stdout.split("\n").some((l) => l.includes(`STREAM_WROTE:${out}`));

    if (res.exitCode !== 0 || !wrote) {
      const tail = `${res.stdout}\n${res.stderr}`.split("\n").map((l) => l.trim()).filter(Boolean).slice(-5);
      return { ...fail([`KLayout stream-out failed (exit ${res.exitCode}).`, ...tail]), ...(cellsWritten !== undefined ? { cellsWritten } : {}) };
    }

    return {
      success: true, defFile, gdsFile: out,
      ...(cellsWritten !== undefined ? { cellsWritten } : {}),
      warnings: [],
      errors: [],
    };
  } finally {
    await fs.rm(scriptPath, { force: true });
  }
}
