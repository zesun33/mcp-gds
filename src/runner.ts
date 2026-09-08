import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
import * as fs from "node:fs";

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type RuntimeType = "podman" | "docker" | "host";

function existingDir(p: string): string | null {
  try {
    return fs.statSync(p).isDirectory() ? p : null;
  } catch {
    return null;
  }
}

export class ToolRunner {
  private runtime: RuntimeType;
  private imageName: string;
  private platformsDir: string | null;
  private pdkDir: string | null;

  constructor() {
    const envRuntime = process.env.MCP_GDS_RUNTIME as RuntimeType | undefined;
    this.imageName = process.env.MCP_GDS_IMAGE || "ghcr.io/zesun33/asic";
    this.platformsDir = existingDir(path.resolve(projectRoot, "platforms"));
    // Optional PDK variant dir (the one containing libs.tech/libs.ref),
    // e.g. <cache>/volare/sky130/versions/<sha>/sky130A. Mounted at /pdk.
    const pdkEnv = process.env.MCP_GDS_PDK_ROOT || process.env.PDK_ROOT || "";
    // Guard: podman auto-creates missing -v sources (as root), so only
    // mount when the directory actually exists.
    this.pdkDir = null;
    if (pdkEnv) {
      try {
        const st = fs.statSync(path.resolve(pdkEnv));
        if (st.isDirectory()) this.pdkDir = path.resolve(pdkEnv);
      } catch {
        this.pdkDir = null;
      }
    }

    if (envRuntime && ["podman", "docker", "host"].includes(envRuntime)) {
      this.runtime = envRuntime;
    } else {
      // Default to podman if available, otherwise host
      this.runtime = "podman";
    }
  }

  public getRuntime(): RuntimeType {
    return this.runtime;
  }

  public getImageName(): string {
    return this.imageName;
  }

  public getPdkDir(): string | null {
    return this.pdkDir;
  }

  public setRuntime(runtime: RuntimeType): void {
    this.runtime = runtime;
  }

  /**
   * Executes a command either directly on host or wrapped in Podman/Docker.
   * If running in container, mounts the workspace directory as /workspace:Z.
   */
  public async execute(
    command: string,
    args: string[],
    options: RunOptions = {}
  ): Promise<RunResult> {
    const cwd = path.resolve(options.cwd || process.cwd());
    const timeoutMs = options.timeoutMs ?? 15000;

    let finalCommand = command;
    let finalArgs = args;

    if (this.runtime === "podman" || this.runtime === "docker") {
      finalCommand = this.runtime;
      const containerArgs: string[] = [
        "run",
        "--rm",
      ];

      if (this.runtime === "podman") {
        containerArgs.push("--storage-opt", "overlay.ignore_chown_errors=true");
      }

      // Forward explicit env into the container (spawn env alone only
      // affects the local podman client process).
      if (options.env) {
        for (const [key, val] of Object.entries(options.env)) {
          containerArgs.push("-e", `${key}=${val}`);
        }
      }

      if (this.pdkDir) {
        containerArgs.push("-v", `${this.pdkDir}:/pdk:ro,Z`);
      }
      if (this.platformsDir) {
        containerArgs.push("-v", `${this.platformsDir}:/opt/platforms:ro,Z`);
      }
      containerArgs.push(
        "-v",
        `${cwd}:/workspace:Z`,
        "-w",
        "/workspace",
        this.imageName,
        command,
        ...args
      );

      finalArgs = containerArgs;
    }

    return new Promise<RunResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;

      const child = spawn(finalCommand, finalArgs, {
        cwd,
        env: {
          ...process.env,
          ...(options.env || {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!settled) {
            child.kill("SIGKILL");
          }
        }, 1000);
      }, timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf-8");
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf-8");
      });

      child.on("error", (err: Error) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          resolve({
            exitCode: 1,
            stdout,
            stderr: `${stderr}\nProcess spawn error: ${err.message}`,
            timedOut: false,
          });
        }
      });

      child.on("close", (code: number | null) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          resolve({
            exitCode: code ?? (timedOut ? 124 : 1),
            stdout,
            stderr,
            timedOut,
          });
        }
      });
    });
  }
}
