import { ToolRunner } from "../runner.js";
import { GdsToolchainInfo } from "../parsers/types.js";

async function probe(runner: ToolRunner, cmd: string, args: string[], cwd?: string): Promise<string> {
  // Rootless podman occasionally fails concurrent spawns; retry once.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await runner.execute(cmd, args, { cwd });
      // First non-empty line: some banners (magic) lead with a blank line.
      const out =
        `${res.stdout}\n${res.stderr}`.split("\n").map((l) => l.trim()).find((l) => l.length > 0) || "";
      if (res.exitCode === 0 && out) return out.slice(0, 120);
    } catch {
      // retry below
    }
  }
  return "Not found";
}

export async function getGdsToolchainInfo(runner: ToolRunner, cwd?: string): Promise<GdsToolchainInfo> {
  // Serial probes: concurrent rootless podman spawns flake intermittently.
  const klayout = await probe(runner, "klayout", ["-v"], cwd);
  // magic has no --version flag; the /dev/null load prints its banner.
  const magicRaw = await probe(runner, "magic", ["-dnull", "-noconsole", "/dev/null"], cwd);
  const netgen = await probe(runner, "/usr/lib/netgen/bin/netgen", ["-batch"], cwd);
  const magic = magicRaw
    .split("\n")
    .map((l) => l.trim())
    .find((l) => /^magic\s+\d/i.test(l)) ?? magicRaw;

  return {
    runtime: runner.getRuntime(),
    image: runner.getRuntime() !== "host" ? runner.getImageName() : undefined,
    klayoutVersion: klayout,
    magicVersion: magic,
    netgenVersion: netgen,
  };
}
