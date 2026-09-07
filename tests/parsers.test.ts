import test from "node:test";
import assert from "node:assert/strict";
import { parseGdsInfoJson } from "../src/tools/info.js";
import { parseLyrdb, parseLyrdbDescriptions } from "../src/tools/drc.js";
import { parseLvsLog } from "../src/tools/lvs.js";
import { parseExtStats } from "../src/tools/extract.js";

test("parseGdsInfoJson extracts layout metadata", () => {
  const stdout = `some klayout banner
GDSINFO_JSON:{"dbu":0.001,"cells":[{"name":"T","is_top":true,"bbox_dbu":[0,0,1000,500],"shapes":2,"layers":{"1/0":2}}],"layers":["1/0"]}
`;
  const raw = parseGdsInfoJson(stdout);
  assert.ok(raw);
  assert.equal(raw.dbu, 0.001);
  assert.equal(raw.cells?.length, 1);
  assert.equal(raw.cells?.[0].name, "T");
  assert.equal(parseGdsInfoJson("no marker here"), null);
});

test("parseLyrdb counts violations per rule with multiplicity", () => {
  const xml = `<?xml version="1.0"?>
<report-database>
 <categories>
  <category><name>M1.W.1</name><description>min width</description></category>
 </categories>
 <items>
  <item><category>'M1.W.1'</category><multiplicity>2</multiplicity></item>
  <item><category>'M1.S.1'</category><multiplicity>1</multiplicity></item>
 </items>
</report-database>`;
  const violations = parseLyrdb(xml);
  assert.equal(violations.length, 2);
  assert.equal(violations.find((v) => v.rule === "M1.W.1")?.count, 2);
  const descs = parseLyrdbDescriptions(xml);
  assert.equal(descs.get("M1.W.1"), "min width");
  assert.deepEqual(parseLyrdb("<report-database></report-database>"), []);
});

test("parseLvsLog distinguishes match from mismatch", () => {
  const matchLog = `Subcircuit summary:\n Number of devices: 2 |Number of devices: 2\n Number of nets: 4 |Number of nets: 4\nFinal result: Circuits match uniquely.\n`;
  const m = parseLvsLog(matchLog);
  assert.equal(m.match, true);
  assert.equal(m.netCount1, 4);
  assert.equal(m.deviceCount1, 2);

  const badLog = `Netlists do not match.\nProperty errors were found.\n`;
  assert.equal(parseLvsLog(badLog).match, false);
  assert.equal(parseLvsLog("empty output").match, null);
});

test("parseExtStats is tolerant of missing counters", () => {
  assert.deepEqual(parseExtStats("nothing here"), {});
  const stats = parseExtStats("Extracted 12 devices and 8 nets");
  assert.equal(stats.devices, 12);
  assert.equal(stats.nets, 8);
});
