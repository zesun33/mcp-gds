import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ToolRunner } from "../src/runner.js";
import { runGdsInfo } from "../src/tools/info.js";
import { runStreamOut } from "../src/tools/stream.js";
import { runDrc } from "../src/tools/drc.js";
import { runLvs } from "../src/tools/lvs.js";
import { runExtract } from "../src/tools/extract.js";
import { getGdsToolchainInfo } from "../src/tools/toolchain.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const runner = new ToolRunner();

async function makeTestGds(name: string, boxes: Array<[number, number, number, number]>): Promise<string> {
  const script = `import pya
ly = pya.Layout()
ly.dbu = 0.001
top = ly.create_cell("T")
l1 = ly.layer(1, 0)
${boxes.map((b) => `top.shapes(l1).insert(pya.Box(${b[0]}, ${b[1]}, ${b[2]}, ${b[3]}))`).join("\n")}
ly.write(${JSON.stringify(name)})
print("WROTE")
`;
  const scriptName = `.gds_mk_tmp_${Date.now()}.py`;
  await fs.writeFile(path.join(projectRoot, scriptName), script, "utf-8");
  try {
    const res = await runner.execute("klayout", ["-b", "-z", "-r", scriptName], {
      cwd: projectRoot,
      timeoutMs: 60000,
    });
    assert.equal(res.exitCode, 0, `GDS fixture build failed: ${res.stderr}`);
  } finally {
    await fs.rm(path.join(projectRoot, scriptName), { force: true });
  }
  return name;
}

test("Integration: gds_toolchain_info probes klayout, magic, netgen", async () => {
  const info = await getGdsToolchainInfo(runner, projectRoot);
  assert.equal(info.runtime, "podman");
  assert.match(info.klayoutVersion, /KLayout/i);
  assert.match(info.magicVersion, /Magic/i);
  assert.ok(info.netgenVersion.length > 0);
});

test("Integration: gds_info reads cells, layers, and bbox", async () => {
  const gds = await makeTestGds("info_tmp.gds", [[0, 0, 1000, 500]]);
  try {
    const res = await runGdsInfo(runner, gds, projectRoot);
    assert.equal(res.success, true, `gds_info failed: ${res.errors.join("; ")}`);
    assert.deepEqual(res.topCells, ["T"]);
    assert.ok(res.layers.some((l) => l.layer === "1/0"));
    assert.equal(res.totalShapes, 1);
    const cell = res.cells.find((c) => c.name === "T");
    assert.ok(cell?.bboxUm);
    assert.deepEqual(cell?.bboxUm, [0, 0, 1, 0.5]);
  } finally {
    await fs.rm(path.join(projectRoot, gds), { force: true });
  }
});

test("Integration: gds_stream_out converts mini DEF to GDS", async () => {
  const res = await runStreamOut(runner, "fixtures/mini.def", "stream_tmp.gds", undefined, undefined, projectRoot);
  assert.equal(res.success, true, `stream-out failed: ${res.errors.join("; ")}`);
  try {
    const info = await runGdsInfo(runner, "stream_tmp.gds", projectRoot);
    assert.equal(info.success, true);
    assert.ok(info.totalShapes >= 0);
    assert.ok((res.cellsWritten ?? 0) > 0);
  } finally {
    await fs.rm(path.join(projectRoot, "stream_tmp.gds"), { force: true });
  }
});

test("Integration: drc_klayout flags violations on generated deck", async () => {
  // 50nm box violates 0.1um width; 50nm gap violates 0.2um space.
  const gds = await makeTestGds("drc_bad_tmp.gds", [[2000, 0, 2050, 500], [2100, 0, 3100, 500]]);
  try {
    const res = await runDrc(runner, {
      gdsFile: gds,
      widthUm: 0.1,
      spaceUm: 0.2,
      reportFile: "drc_bad_tmp.lyrdb",
      cwd: projectRoot,
    });
    assert.equal(res.success, true, `DRC failed: ${res.errors.join("; ")}`);
    assert.equal(res.clean, false);
    assert.ok(res.totalViolations >= 2, `Expected >= 2 violations, got ${res.totalViolations}`);
    assert.ok(res.violations.some((v) => v.rule.startsWith("W_1/0")));
    assert.ok(res.violations.some((v) => v.rule.startsWith("S_1/0")));
  } finally {
    await fs.rm(path.join(projectRoot, gds), { force: true });
    await fs.rm(path.join(projectRoot, "drc_bad_tmp.lyrdb"), { force: true });
  }
});

test("Integration: drc_klayout is clean on compliant geometry with custom deck", async () => {
  const gds = await makeTestGds("drc_good_tmp.gds", [[0, 0, 2000, 2000]]);
  try {
    const res = await runDrc(runner, {
      gdsFile: gds,
      deckFile: "decks/example_custom.drc",
      reportFile: "drc_good_tmp.lyrdb",
      cwd: projectRoot,
    });
    assert.equal(res.success, true, `DRC failed: ${res.errors.join("; ")}`);
    assert.equal(res.clean, true);
    assert.equal(res.totalViolations, 0);
  } finally {
    await fs.rm(path.join(projectRoot, gds), { force: true });
    await fs.rm(path.join(projectRoot, "drc_good_tmp.lyrdb"), { force: true });
  }
});

test("Integration: lvs_netgen matches identical netlists", async () => {
  const res = await runLvs(runner, {
    schematicNetlist: "fixtures/inv_a.spice",
    schematicCell: "inv",
    layoutNetlist: "fixtures/inv_b.spice",
    layoutCell: "inv",
    cwd: projectRoot,
  });
  assert.equal(res.success, true, `LVS failed: ${res.errors.join("; ")}`);
  assert.equal(res.match, true);
  assert.equal(res.netCount1, 4);
  assert.equal(res.deviceCount1, 2);
});

test("Integration: lvs_netgen reports property mismatch", async () => {
  const res = await runLvs(runner, {
    schematicNetlist: "fixtures/inv_a.spice",
    schematicCell: "inv",
    layoutNetlist: "fixtures/inv_c_mismatch.spice",
    layoutCell: "inv",
    cwd: projectRoot,
  });
  assert.equal(res.success, true);
  assert.equal(res.match, false);
});

test("Integration: extract_magic fails gracefully without PDK tech", async () => {
  const res = await runExtract(runner, {
    source: "does-not-exist.mag",
    cwd: projectRoot,
  });
  assert.equal(res.success, false);
  assert.ok(res.errors.length > 0);
});
