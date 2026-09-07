import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ToolRunner } from "../runner.js";
import { infoScript } from "../scripts.js";
import { GdsInfoResult, GdsCellInfo, GdsLayerInfo } from "../parsers/types.js";

interface RawCell {
  name: string;
  is_top: boolean;
  bbox_dbu: [number, number, number, number] | null;
  shapes: number;
  layers: Record<string, number>;
}

interface RawInfo {
  dbu?: number;
  cells?: RawCell[];
  layers?: string[];
}

export function parseGdsInfoJson(stdout: string): RawInfo | null {
  for (const line of stdout.split("\n")) {
    const idx = line.indexOf("GDSINFO_JSON:");
    if (idx !== -1) {
      try {
        return JSON.parse(line.slice(idx + "GDSINFO_JSON:".length)) as RawInfo;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Reads GDSII/OASIS layout metadata headlessly: cells, top cells,
 * bounding boxes, per-layer shape counts. Pure introspection, no PDK.
 */
export async function runGdsInfo(
  runner: ToolRunner,
  gdsFile: string,
  cwd?: string
): Promise<GdsInfoResult> {
  const fail = (errors: string[]): GdsInfoResult => ({
    success: false, gdsFile, cells: [], topCells: [], layers: [],
    totalShapes: 0, warnings: [], errors,
  });

  if (!gdsFile) return fail(["No GDS file specified."]);

  const base = path.resolve(cwd || process.cwd());
  const scriptName = `.gds_info_tmp_${Date.now()}.py`;
  const scriptPath = path.join(base, scriptName);

  try {
    await fs.writeFile(scriptPath, infoScript(gdsFile), "utf-8");
    const res = await runner.execute("klayout", ["-b", "-z", "-r", scriptName], {
      cwd: base,
      timeoutMs: 60000,
    });

    if (res.exitCode !== 0) {
      return fail([`klayout info failed (exit ${res.exitCode}): ${res.stderr.trim().split("\n").pop() || "unknown error"}`]);
    }

    const raw = parseGdsInfoJson(res.stdout);
    if (!raw) {
      return fail(["klayout produced no parseable layout info (GDSINFO_JSON missing)."]);
    }

    const dbu = raw.dbu ?? 0.001;
    const cells: GdsCellInfo[] = (raw.cells ?? []).map((c) => ({
      name: c.name,
      bboxUm: c.bbox_dbu
        ? [c.bbox_dbu[0] * dbu, c.bbox_dbu[1] * dbu, c.bbox_dbu[2] * dbu, c.bbox_dbu[3] * dbu] as [number, number, number, number]
        : undefined,
      shapes: c.shapes,
    }));
    const topCells = (raw.cells ?? []).filter((c) => c.is_top).map((c) => c.name);
    const layerTotals = new Map<string, number>();
    for (const c of raw.cells ?? []) {
      for (const [layer, n] of Object.entries(c.layers ?? {})) {
        layerTotals.set(layer, (layerTotals.get(layer) ?? 0) + n);
      }
    }
    const layers: GdsLayerInfo[] = [...layerTotals.entries()]
      .map(([layer, shapes]) => ({ layer, shapes }))
      .sort((a, b) => b.shapes - a.shapes);
    const totalShapes = layers.reduce((n, l) => n + l.shapes, 0);

    return {
      success: true, gdsFile, dbu,
      cells, topCells, layers, totalShapes,
      warnings: [], errors: [],
    };
  } finally {
    await fs.rm(scriptPath, { force: true });
  }
}
