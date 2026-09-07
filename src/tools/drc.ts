import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ToolRunner } from "../runner.js";
import { runGdsInfo } from "./info.js";
import { DrcResult, DrcViolation } from "../parsers/types.js";

export interface DrcOptions {
  gdsFile: string;
  layers?: string[];
  widthUm?: number;
  spaceUm?: number;
  deckFile?: string;
  /**
   * PDK shorthand (currently "sky130A"): runs the PDK's own KLayout DRC
   * deck. Needs MCP_GDS_PDK_ROOT at a volare version dir. Explicit
   * deckFile always wins.
   */
  pdk?: string;
  reportFile?: string;
  cwd?: string;
  timeoutMs?: number;
}

const PDK_DRC_DECKS: Record<string, string> = {
  sky130A: "/pdk/sky130A/libs.tech/klayout/drc/sky130A.lydrc",
};

export function parseLyrdb(xml: string): DrcViolation[] {
  const byRule = new Map<string, { description?: string; count: number }>();
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    const body = m[1];
    const cat = body.match(/<category>'?([^'<]+)'?<\/category>/);
    const mult = body.match(/<multiplicity>(\d+)<\/multiplicity>/);
    const rule = (cat ? cat[1] : "unknown").trim();
    const entry = byRule.get(rule) ?? { count: 0 };
    entry.count += mult ? parseInt(mult[1], 10) : 1;
    byRule.set(rule, entry);
  }
  return [...byRule.entries()].map(([rule, v]) => ({ rule, count: v.count }));
}

export function parseLyrdbDescriptions(xml: string): Map<string, string> {
  const descs = new Map<string, string>();
  const catRe = /<category>\s*<name>([^<]+)<\/name>\s*<description>([^<]*)<\/description>/g;
  let m: RegExpExecArray | null;
  while ((m = catRe.exec(xml)) !== null) {
    descs.set(m[1].trim(), m[2].trim());
  }
  return descs;
}

function generatedDeck(layers: string[], widthUm: number, spaceUm: number): string {
  const lines = ["source($input)", 'report("generic geometry smoke", $report)', ""];
  for (const layer of layers) {
    const lm = layer.match(/^(\d+)\/(\d+)$/);
    if (!lm) continue;
    const [, l, d] = lm;
    const v = `l${l}_${d}`;
    const tag = `${l}/${d}`;
    lines.push(`${v} = input(${l}, ${d})`);
    lines.push(`${v}.width(${widthUm}.um).output("W_${tag}", "min width ${widthUm}um on ${tag}")`);
    lines.push(`${v}.space(${spaceUm}.um).output("S_${tag}", "min space ${spaceUm}um on ${tag}")`);
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Runs KLayout batch DRC. Default: generated generic width/space smoke deck
 * over the layout's own layers (honest geometry sanity, NOT foundry signoff).
 * Pass deckFile for a real PDK rule deck.
 */
export async function runDrc(
  runner: ToolRunner,
  options: DrcOptions
): Promise<DrcResult> {
  const fail = (errors: string[]): DrcResult => ({
    success: false, gdsFile: options.gdsFile, deck: options.deckFile ?? "generated-generic",
    violations: [], totalViolations: 0, clean: false, warnings: [], errors,
  });

  if (!options.gdsFile) return fail(["No GDS file specified."]);

  const base = path.resolve(options.cwd || process.cwd());
  const report = options.reportFile || options.gdsFile.replace(/\.(gds|oas)$/i, "") + ".lyrdb";
  const ts = Date.now();
  const tmpDeck = `.gds_deck_tmp_${ts}.drc`;

  try {
    let deck = options.deckFile;
    if (!deck && options.pdk) {
      deck = PDK_DRC_DECKS[options.pdk];
      if (!deck) {
        return fail([
          `Unknown pdk "${options.pdk}". Supported: ${Object.keys(PDK_DRC_DECKS).join(", ")}.`,
        ]);
      }
    }
    if (!deck) {
      const info = await runGdsInfo(runner, options.gdsFile, options.cwd);
      if (!info.success) {
        return fail([`Cannot enumerate layout layers: ${info.errors.join("; ")}`]);
      }
      const layers = options.layers ?? info.layers.map((l) => l.layer);
      if (layers.length === 0) {
        return fail(["No layers found to check (empty layout)."]);
      }
      deck = tmpDeck;
      await fs.writeFile(
        path.join(base, tmpDeck),
        generatedDeck(layers, options.widthUm ?? 0.06, options.spaceUm ?? 0.09),
        "utf-8"
      );
    }

    const res = await runner.execute(
      "klayout",
      ["-b", "-rd", `input=${options.gdsFile}`, "-rd", `report=${report}`, "-r", deck ?? tmpDeck],
      { cwd: base, timeoutMs: options.timeoutMs ?? 120000 }
    );

    if (res.exitCode !== 0) {
      const tail = `${res.stdout}\n${res.stderr}`.split("\n").map((l) => l.trim()).filter(Boolean).slice(-5);
      return { ...fail([`KLayout DRC failed (exit ${res.exitCode}).`, ...tail]), reportFile: report };
    }

    let xml = "";
    try {
      xml = await fs.readFile(path.join(base, report), "utf-8");
    } catch {
      return { ...fail(["DRC ran but no report database was written."]), reportFile: report };
    }

    const violations = parseLyrdb(xml);
    const descs = parseLyrdbDescriptions(xml);
    for (const v of violations) {
      const d = descs.get(v.rule);
      if (d) v.description = d;
    }
    const total = violations.reduce((n, v) => n + v.count, 0);

    return {
      success: true, gdsFile: options.gdsFile, deck: options.deckFile ?? "generated-generic",
      violations: violations.sort((a, b) => b.count - a.count),
      totalViolations: total, clean: total === 0,
      reportFile: report, warnings: [], errors: [],
    };
  } finally {
    await fs.rm(path.join(base, tmpDeck), { force: true });
  }
}
