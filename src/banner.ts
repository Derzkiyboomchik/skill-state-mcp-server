/**
 * Terminal banner and stylized ASCII branding for SKILL.state MCP runtime.
 */

// Standard ANSI escape codes for cross-platform vibrant terminal output
export const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  brightCyan: "\x1b[96m",
  magenta: "\x1b[35m",
  brightMagenta: "\x1b[95m",
  blue: "\x1b[34m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  gray: "\x1b[90m",
};

export function getAsciiBanner(): string {
  const c = ANSI.brightCyan;
  const m = ANSI.brightMagenta;
  const r = ANSI.reset;
  const b = ANSI.bold;
  const g = ANSI.gray;

  return [
    `${c}  ███████╗██╗  ██╗██╗██╗     ██╗     ${m}███████╗████████╗ █████╗ ████████╗███████╗${r}`,
    `${c}  ██╔════╝██║ ██╔╝██║██║     ██║     ${m}██╔════╝╚══██╔══╝██╔══██╗╚══██╔══╝██╔════╝${r}`,
    `${c}  ███████╗█████╔╝ ██║██║     ██║     ${m}███████╗   ██║   ███████║   ██║   █████╗  ${r}`,
    `${c}  ╚════██║██╔═██╗ ██║██║     ██║     ${m}╚════██║   ██║   ██╔══██║   ██║   ██╔══╝  ${r}`,
    `${c}  ███████║██║  ██╗██║███████╗███████╗${m}███████║   ██║   ██║  ██║   ██║   ███████╗${r}`,
    `${c}  ╚══════╝╚═╝  ╚═╝╚═╝╚══════╝╚══════╝${m}╚══════╝   ╚═╝   ╚═╝  ╚═╝   ╚═╝   ╚══════╝${r}`,
    ``,
    `  ${b}SKILL.state MCP Runtime${r} ${g}·${r} ${c}v1.0.0${r} ${g}·${r} ${m}arXiv:2608.26263${r}`,
    `  ${g}Replacing append-only conversation history with mutable execution state (P, Σ, O)${r}`,
    ``,
  ].join("\n");
}

export function printCliBanner(): void {
  process.stderr.write(getAsciiBanner());
}

/**
 * Animated terminal loader for demo / CLI setups.
 */
export async function animateStep(message: string, durationMs = 300): Promise<void> {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const startTime = Date.now();

  return new Promise((resolve) => {
    const interval = setInterval(() => {
      const frame = frames[i++ % frames.length];
      process.stdout.write(`\r${ANSI.brightCyan}${frame}${ANSI.reset} ${message}`);
      if (Date.now() - startTime >= durationMs) {
        clearInterval(interval);
        process.stdout.write(`\r${ANSI.green}✔${ANSI.reset} ${message}\n`);
        resolve();
      }
    }, 40);
  });
}
