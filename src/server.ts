import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { ToolRunner } from "./runner.js";
import { runGdsInfo } from "./tools/info.js";
import { runStreamOut } from "./tools/stream.js";
import { runDrc } from "./tools/drc.js";
import { runLvs } from "./tools/lvs.js";
import { runExtract } from "./tools/extract.js";
import { getGdsToolchainInfo } from "./tools/toolchain.js";

export function createServer(runner: ToolRunner = new ToolRunner()): Server {
  const server = new Server(
    {
      name: "@zesun33/mcp-gds",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  const tools: Tool[] = [
    {
      name: "gds_info",
      description:
        "Reads GDSII/OASIS layout metadata headlessly (cells, top cells, bounding boxes, per-layer shape counts). Pure introspection, no PDK needed. Use when you need to know what is inside a layout file.",
      inputSchema: {
        type: "object",
        properties: {
          gds_file: {
            type: "string",
            description: "Path to the GDSII/OASIS layout file.",
          },
          cwd: {
            type: "string",
            description: "Optional working directory.",
          },
        },
        required: ["gds_file"],
      },
    },
    {
      name: "gds_stream_out",
      description:
        "Streams a DEF layout to GDSII via headless KLayout using Nangate45 LEFs (abstract cell footprints; full transistor GDS needs the PDK). Use to produce DRC input or handoff previews, not tapeout signoff.",
      inputSchema: {
        type: "object",
        properties: {
          def_file: {
            type: "string",
            description: "Input DEF file path.",
          },
          gds_file: {
            type: "string",
            description: "Output GDSII path (default: <def basename>.gds).",
          },
          cwd: {
            type: "string",
            description: "Optional working directory.",
          },
        },
        required: ["def_file"],
      },
    },
    {
      name: "drc_klayout",
      description:
        "Runs KLayout batch DRC on a GDS file. Default is a generated generic width/space smoke deck over the layout's own layers (geometry sanity, not foundry signoff). Pass deck_file for a real PDK rule deck. Does not do LVS; use lvs_netgen for netlist comparison.",
      inputSchema: {
        type: "object",
        properties: {
          gds_file: {
            type: "string",
            description: "GDSII layout file to check.",
          },
          deck_file: {
            type: "string",
            description: "Optional custom KLayout .drc rule deck (batch-mode with source()/report()).",
          },
          width_um: {
            type: "number",
            description: "Generic-deck min width in um (default: 0.06).",
          },
          space_um: {
            type: "number",
            description: "Generic-deck min space in um (default: 0.09).",
          },
          cwd: {
            type: "string",
            description: "Optional working directory.",
          },
        },
        required: ["gds_file"],
      },
    },
    {
      name: "lvs_netgen",
      description:
        "Compares two SPICE netlists with Netgen batch LVS and reports match/mismatch with net/device counts. Compares netlists only; use extract_magic to derive a layout netlist first. Does not do DRC.",
      inputSchema: {
        type: "object",
        properties: {
          schematic_netlist: {
            type: "string",
            description: "Reference (schematic) SPICE file.",
          },
          schematic_cell: {
            type: "string",
            description: "Top cell name in the schematic netlist.",
          },
          layout_netlist: {
            type: "string",
            description: "Layout-extracted SPICE file.",
          },
          layout_cell: {
            type: "string",
            description: "Top cell name in the layout netlist.",
          },
          setup_file: {
            type: "string",
            description: "Optional Netgen setup file for device-class mapping (default: nosetup).",
          },
          cwd: {
            type: "string",
            description: "Optional working directory.",
          },
        },
        required: ["schematic_netlist", "schematic_cell", "layout_netlist", "layout_cell"],
      },
    },
    {
      name: "extract_magic",
      description:
        "Extracts a SPICE netlist from layout with Magic batch mode (ext2spice lvs). Runs on generic technology: correct flow plumbing, but device-accurate extraction needs a PDK tech file.",
      inputSchema: {
        type: "object",
        properties: {
          source: {
            type: "string",
            description: "Magic (.mag) or GDSII source layout.",
          },
          output_spice: {
            type: "string",
            description: "Output SPICE path (default: <source>_extracted.spice).",
          },
          cell: {
            type: "string",
            description: "Optional cell to select before extraction.",
          },
          tech_file: {
            type: "string",
            description: "Optional Magic technology file (required for device-accurate extraction).",
          },
          cwd: {
            type: "string",
            description: "Optional working directory.",
          },
        },
        required: ["source"],
      },
    },
    {
      name: "gds_toolchain_info",
      description:
        "Returns active container/host runtime and versions of KLayout, Magic, and Netgen.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
  ];

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    try {
      switch (name) {
        case "gds_info": {
          const result = await runGdsInfo(
            runner,
            (args.gds_file as string) || "",
            args.cwd as string | undefined
          );
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }

        case "gds_stream_out": {
          const result = await runStreamOut(
            runner,
            (args.def_file as string) || "",
            args.gds_file as string | undefined,
            undefined,
            undefined,
            args.cwd as string | undefined
          );
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }

        case "drc_klayout": {
          const result = await runDrc(runner, {
            gdsFile: (args.gds_file as string) || "",
            deckFile: args.deck_file as string | undefined,
            widthUm: typeof args.width_um === "number" ? args.width_um : undefined,
            spaceUm: typeof args.space_um === "number" ? args.space_um : undefined,
            cwd: args.cwd as string | undefined,
          });
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }

        case "lvs_netgen": {
          const result = await runLvs(runner, {
            schematicNetlist: (args.schematic_netlist as string) || "",
            schematicCell: (args.schematic_cell as string) || "",
            layoutNetlist: (args.layout_netlist as string) || "",
            layoutCell: (args.layout_cell as string) || "",
            setupFile: args.setup_file as string | undefined,
            cwd: args.cwd as string | undefined,
          });
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }

        case "extract_magic": {
          const result = await runExtract(runner, {
            source: (args.source as string) || "",
            outputSpice: args.output_spice as string | undefined,
            cell: args.cell as string | undefined,
            techFile: args.tech_file as string | undefined,
            cwd: args.cwd as string | undefined,
          });
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }

        case "gds_toolchain_info": {
          const result = await getGdsToolchainInfo(runner);
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }

        default:
          return {
            content: [{ type: "text", text: `Error: Unknown tool "${name}".` }],
            isError: true,
          };
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Tool execution failed: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}
