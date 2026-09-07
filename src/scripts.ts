/**
 * KLayout batch Python snippets, generated per-call with concrete paths.
 * Executed headless via `klayout -b -z -r <script>`. All paths are
 * workspace-relative (cwd is mounted at /workspace in the container).
 */

export function infoScript(gdsFile: string): string {
  return `import pya, json
ly = pya.Layout()
ly.read(${JSON.stringify(gdsFile)})
child_ids = set()
for c in ly.each_cell():
    for inst in c.each_inst():
        child_ids.add(inst.cell_index)
cells = []
for c in ly.each_cell():
    per_layer = {}
    total = 0
    for li in ly.layer_infos():
        n = c.shapes(ly.layer(li)).size()
        if n > 0:
            per_layer["%d/%d" % (li.layer, li.datatype)] = n
            total += n
    bbox = c.bbox()
    cells.append({
        "name": c.name,
        "is_top": c.cell_index() not in child_ids,
        "bbox_dbu": [bbox.left, bbox.bottom, bbox.right, bbox.top] if not bbox.empty() else None,
        "shapes": total,
        "layers": per_layer,
    })
out = {
    "dbu": ly.dbu,
    "cells": cells,
    "layers": sorted(list(set(sum([list(c["layers"].keys()) for c in cells], [])))),
}
print("GDSINFO_JSON:" + json.dumps(out))
`;
}

export function streamOutScript(
  defFile: string,
  techLef: string,
  macroLef: string,
  outGds: string,
  mapFile?: string
): string {
  // A LEF/DEF layer map (e.g. the PDK sky130A.map) is required for real GDS
  // layer numbers: plain LEF carries no GDS numbers, so without a map KLayout
  // assigns pseudo-layers and downstream extraction finds no connectivity.
  const mapLine = mapFile
    ? `\nopt.lefdef_config.map_file = ${JSON.stringify(mapFile)}`
    : "";
  return `import pya
opt = pya.LoadLayoutOptions()
opt.lefdef_config.read_lef_with_def = False
opt.lefdef_config.lef_files = [${JSON.stringify(techLef)}, ${JSON.stringify(macroLef)}]${mapLine}
ly = pya.Layout()
ly.read(${JSON.stringify(defFile)}, opt)
# Report first so a write failure still leaves diagnostics.
print("STREAM_CELLS:" + str(len([c for c in ly.each_cell()])))
ly.write(${JSON.stringify(outGds)})
print("STREAM_WROTE:" + ${JSON.stringify(outGds)})
`;
}
