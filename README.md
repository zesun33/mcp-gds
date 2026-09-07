# @zesun33/mcp-gds

> Model Context Protocol (MCP) server for GDSII stream-out, KLayout DRC, Netgen LVS, and Magic extraction.

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![CI](https://github.com/zesun33/mcp-gds/actions/workflows/ci.yml/badge.svg)](https://github.com/zesun33/mcp-gds/actions/workflows/ci.yml)
[![Protocol: MCP](https://img.shields.io/badge/protocol-MCP_stdio-blueviolet)](https://modelcontextprotocol.io)
[![Runtime: Rootless Podman](https://img.shields.io/badge/runtime-rootless_podman-brightgreen)](#execution-runtime)

`mcp-gds` gives AI coding agents and IDEs (**Cursor**, **Windsurf**, **GitHub Copilot / OpenAI Codex**, **Claude Code**, **Google Antigravity**, **OpenCode**, **Cline**) structured, token-capped access to open-source physical-verification tools. It closes the loop after `mcp-openroad` place-and-route: stream the DEF to GDSII, smoke-check geometry with KLayout, compare netlists with Netgen, and extract with Magic — without pasting thousand-line tool logs into context.

> Scope honesty: geometry decks here are smoke-level sanity checks, not foundry signoff. Netgen compares SPICE-vs-SPICE structurally (`nosetup` by default; pass a PDK setup file for device mapping). Magic runs on generic technology until a PDK tech file is provided. Use `extract_magic` to derive layout netlists, then `lvs_netgen` to compare them.

## Foundry PDK Support (Sky130)

With a Sky130 PDK on disk (fetch once: `volare fetch --pdk sky130 -l sky130_fd_sc_hd <sha>`,
~770MB), point the server at the volare version dir and the flow turns real:

```bash
export MCP_GDS_PDK_ROOT=/path/to/pdks/volare/sky130/versions/<sha>
```

| Capability | Without PDK | With PDK |
| :--- | :--- | :--- |
| `lvs_netgen` | structural compare (`nosetup`) | `pdk: "sky130A"` uses the real `sky130A_setup.tcl` with device mapping |
| `extract_magic` | generic tech (flow plumbing) | `-rcfile` Sky130 tech + `PDK_ROOT=/pdk`: real transistor extraction |
| `drc_klayout` | generated smoke deck | `pdk: "sky130A"` runs the foundry `sky130A.lydrc` deck |

Validated live: Magic-extracted `sky130_fd_sc_hd__inv_1` (nfet+pfet with areas) matches the PDK reference netlist (`Netlists match uniquely`, 6/6 nets, 2/2 devices). Magic ≥ 8.3.411 is required by the Sky130 tech (the ASIC image ships conda Magic 8.3.486).

---

## ⚡ Quick Tour: See It in Action

### Real Agent Scenarios in 60 Seconds

#### 1. Probing the Toolchain (Zero-Config Verification)
```json
// Tool Call: gds_toolchain_info
{
  "runtime": "podman",
  "image": "ghcr.io/zesun33/asic",
  "klayoutVersion": "KLayout 0.28.16",
  "magicVersion": "Magic 8.3 revision 105",
  "netgenVersion": "Netgen 1.5.133"
}
```

#### 2. Layout Introspection Without a Viewer
```json
// Tool Call: gds_info {"gds_file": "counter.gds"}
{
  "success": true,
  "topCells": ["counter"],
  "layers": [{ "layer": "31/0", "shapes": 128 }],
  "totalShapes": 256
}
```

#### 3. DEF-to-GDS Stream-Out (Abstract-Level Handoff)
```json
// Tool Call: gds_stream_out {"def_file": "counter_routed.def"}
{
  "success": true,
  "gdsFile": "counter_routed.gds",
  "cellsWritten": 14
}
```

#### 4. Geometry Smoke DRC in One Call
```json
// Tool Call: drc_klayout {"gds_file": "counter.gds"}
{
  "success": true,
  "clean": true,
  "totalViolations": 0,
  "deck": "generated-generic"
}
```

#### 5. Netlist-vs-Netlist LVS Verdict
```json
// Tool Call: lvs_netgen {"schematic_netlist": "inv_a.spice", "schematic_cell": "inv", "layout_netlist": "inv_b.spice", "layout_cell": "inv"}
{
  "success": true,
  "match": true,
  "netCount1": 4,
  "netCount2": 4,
  "deviceCount1": 2,
  "deviceCount2": 2
}
```

---

## Tools Exposed

| Tool | Parameters | Engine | Description |
| :--- | :--- | :--- | :--- |
| `gds_info` | `gds_file: string`, `cwd?: string` | KLayout `pya` headless | Cells, top cells, bounding boxes, per-layer shape counts. No PDK needed. |
| `gds_stream_out` | `def_file: string`, `gds_file?: string`, `pdk?: "sky130A"`, `cwd?: string` | KLayout + Nangate45 LEFs | DEF-to-GDSII stream-out (abstract cell footprints; full transistor GDS needs the PDK). `pdk: "sky130A"` (needs `MCP_GDS_PDK_ROOT`) resolves Sky130 macros via PDK LEFs **and** applies the foundry `sky130A.map` layer map — without it KLayout emits pseudo-layers and Magic extraction finds no connectivity. |
| `drc_klayout` | `gds_file: string`, `deck_file?: string`, `width_um?: number`, `space_um?: number`, `cwd?: string` | KLayout batch `-b -r` | Generated generic width/space smoke deck over the layout's own layers, or a custom `.drc` deck. Parses `.lyrdb` to per-rule counts. Smoke-level, not foundry signoff. |
| `lvs_netgen` | `schematic_netlist: string`, `schematic_cell: string`, `layout_netlist: string`, `layout_cell: string`, `setup_file?: string`, `cwd?: string` | Netgen `-batch lvs -json` | SPICE-vs-SPICE comparison with net/device counts. Property errors count as mismatch. Does not do DRC. |
| `extract_magic` | `source: string`, `output_spice?: string`, `cell?: string`, `tech_file?: string`, `cwd?: string` | Magic `ext2spice lvs` | Batch netlist extraction. Generic technology until a PDK tech file is provided. |
| `gds_toolchain_info` | *none* | Probe | Returns container/host runtime and versions of KLayout, Magic, and Netgen. |

---

## Execution Runtime

`mcp-gds` runs inside the [`zesun33/asic`](https://github.com/zesun33/eda-docker-images) rootless Podman image so tools are identical on any Linux host.

**Public install (recommended — anyone can pull):**
```bash
podman pull ghcr.io/zesun33/asic:latest
export MCP_GDS_IMAGE=ghcr.io/zesun33/asic
```

Local builds from `eda-docker-images` still work as `localhost/zesun33/asic` (the historical default). Override anytime with `MCP_GDS_IMAGE`.

- Container mount: `-v <workspace>:/workspace:Z -w /workspace`
- Podman storage option: `--storage-opt overlay.ignore_chown_errors=true`

To force host binaries instead of container execution:
```bash
export MCP_GDS_RUNTIME=host
```

The repo `platforms/` directory is mounted read-only at `/opt/platforms` for LEF access. For Sky130 signoff, also set `MCP_GDS_PDK_ROOT` to a host volare cache (see [`eda-docker-images`](https://github.com/zesun33/eda-docker-images) PDK section).


---

## Universal Client & AI IDE Setup

Because `mcp-gds` implements the standard [Model Context Protocol (MCP)](https://modelcontextprotocol.io), it connects seamlessly to any MCP-compliant AI IDE or agent interface:

```json
{
  "mcpServers": {
    "gds": {
      "command": "node",
      "args": ["/path/to/mcp-gds/dist/index.js"]
    }
  }
}
```

- **Cursor**: Configure in `.cursor/mcp.json`.
- **Windsurf**: Configure in `~/.codeium/windsurf/mcp_config.json`.
- **GitHub Copilot / OpenAI Codex**: Configure via Copilot MCP settings or Codex tool proxy.
- **Claude Code**: Configure via `claude mcp add gds node /path/to/dist/index.js`.
- **Google Antigravity**: Load as workspace MCP server in `antigravity.json`.
- **OpenCode & Cline**: Direct stdio JSON-RPC connection.

---

## Verification & Testing

Run the full 6-gate verification suite:

```bash
# Full verification (with Podman container execution)
./scripts/verify.sh

# Fast / CI verification (headless environments)
./scripts/verify.sh --quick
```

## License

Apache-2.0 © 2026 Md Zesun Ahmed Mia
