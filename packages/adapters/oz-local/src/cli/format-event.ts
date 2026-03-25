import pc from "picocolors";

/**
 * oz agent run produces interactive terminal output, not structured JSON events.
 * Each line is printed as-is to the terminal. Debug mode prefixes with a gray marker.
 */
export function printOzStreamEvent(raw: string, debug: boolean): void {
  const line = raw.trimEnd();
  if (!line) return;

  if (debug) {
    console.log(pc.gray("[oz]") + " " + line);
  } else {
    console.log(line);
  }
}
