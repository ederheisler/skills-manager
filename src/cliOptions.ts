export interface CliOptions {
  help: boolean;
  skillsDir?: string;
}

export const helpText = `Usage: skills-manager [--skills-dir <path>]

Manage skills in a selected directory without moving or merging installations.

Options:
  --skills-dir <path>  Select the skills directory directly (default: ~/.agents/skills)
  -h, --help           Show this help and exit

Without --skills-dir, choose a documented global location or enter a path.
Local Git setup and remote backup are optional.
Application and skills CLI updates have separate manual checks.
Background checks are separately opt-in and off by default.
`;

export function parseCliOptions(args: readonly string[]): CliOptions {
  const options: CliOptions = { help: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "-h" || arg === "--help") {
      options.help = true;
      continue;
    }
    if (arg === "--skills-dir" || arg.startsWith("--skills-dir=")) {
      if (options.skillsDir !== undefined) throw new Error("--skills-dir may only be specified once");
      const value = arg === "--skills-dir" ? args[++index] : arg.slice("--skills-dir=".length);
      if (value === undefined || value.length === 0 || (arg === "--skills-dir" && value.startsWith("-"))) {
        throw new Error("--skills-dir requires a path");
      }
      options.skillsDir = value;
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    throw new Error(`Unexpected argument: ${arg}`);
  }
  return options;
}

export function runtimeError(platform: string, arch: string, nodeVersion: string, glibcVersion?: string): string | undefined {
  if (platform !== "darwin" && platform !== "linux") {
    return "Skills Manager supports macOS and Linux; Windows and other platforms are not supported.";
  }
  if (arch !== "arm64" && arch !== "x64") {
    return `Unsupported architecture ${arch}; Skills Manager requires arm64 or x64.`;
  }
  const version = /^(\d+)\.(\d+)\.(\d+)$/.exec(nodeVersion);
  if (!version || Number(version[1]) !== 26 || Number(version[2]) < 13) {
    return `Skills Manager requires Node.js >=26.13.0 <27 (found ${nodeVersion}).`;
  }
  if (platform === "linux" && !glibcVersion) {
    return "Skills Manager requires glibc on Linux; musl and unidentified C libraries are not supported.";
  }
  return undefined;
}
