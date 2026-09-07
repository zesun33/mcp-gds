export interface GdsLayerInfo {
  layer: string;
  shapes: number;
}

export interface GdsCellInfo {
  name: string;
  bboxUm?: [number, number, number, number];
  shapes: number;
}

export interface GdsInfoResult {
  success: boolean;
  gdsFile: string;
  dbu?: number;
  cells: GdsCellInfo[];
  topCells: string[];
  layers: GdsLayerInfo[];
  totalShapes: number;
  warnings: string[];
  errors: string[];
}

export interface StreamOutResult {
  success: boolean;
  defFile: string;
  gdsFile?: string;
  cellsWritten?: number;
  warnings: string[];
  errors: string[];
}

export interface DrcViolation {
  rule: string;
  description?: string;
  count: number;
}

export interface DrcResult {
  success: boolean;
  gdsFile: string;
  deck: string;
  violations: DrcViolation[];
  totalViolations: number;
  clean: boolean;
  reportFile?: string;
  warnings: string[];
  errors: string[];
}

export interface LvsResult {
  success: boolean;
  match: boolean;
  circuit1: string;
  circuit2: string;
  netCount1?: number;
  netCount2?: number;
  deviceCount1?: number;
  deviceCount2?: number;
  logFile?: string;
  warnings: string[];
  errors: string[];
}

export interface ExtractResult {
  success: boolean;
  source: string;
  spiceFile?: string;
  devices?: number;
  nets?: number;
  warnings: string[];
  errors: string[];
}

export interface GdsToolchainInfo {
  runtime: "podman" | "docker" | "host";
  image?: string;
  klayoutVersion: string;
  magicVersion: string;
  netgenVersion: string;
}
