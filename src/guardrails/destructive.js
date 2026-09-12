/**
 * Detection of destructive operations.
 *
 * The default of the action policy is deny-by-default: destructive shell
 * commands and destructive git operations are refused unless a human
 * approval token covers them (or the policy explicitly allows the git
 * variants). Detection is deliberately pattern-based and conservative —
 * unknown commands are not destructive, but the dangerous classics are
 * caught mechanically instead of by prompt discipline.
 */

/**
 * Destructive shell command patterns. Each entry carries the token a
 * human approval must match and a readable description for the failure.
 *
 * @type {readonly { token: string, pattern: RegExp, description: string }[]}
 */
export const DESTRUCTIVE_SHELL_PATTERNS = [
  { token: "shell.execute.destructive", pattern: /(?:^|[\s;&|(])rm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*\s+)+/, description: "recursive/forced file removal (rm -r/-f)" },
  { token: "shell.execute.destructive", pattern: /(?:^|[\s;&|(])rm\s+-[a-zA-Z]*[rf]/, description: "recursive/forced file removal (rm -r/-f)" },
  { token: "shell.execute.destructive", pattern: /git\s+push\s+(?:--force|--force-with-lease|-f)\b/, description: "forced git push" },
  { token: "shell.execute.destructive", pattern: /git\s+reset\s+--hard\b/, description: "git reset --hard" },
  { token: "shell.execute.destructive", pattern: /git\s+clean\s+-[a-zA-Z]*f/, description: "git clean -f" },
  { token: "shell.execute.destructive", pattern: /git\s+checkout\s+(?:--\s+)?\.?\s*$/, description: "git checkout discarding working tree" },
  { token: "shell.execute.destructive", pattern: /(?:^|[\s;&|(])mkfs(?:\.\w+)?\b/, description: "filesystem format (mkfs)" },
  { token: "shell.execute.destructive", pattern: /(?:^|[\s;&|(])dd\s+[^\n]*\bof=/, description: "raw disk write (dd of=)" },
  { token: "shell.execute.destructive", pattern: /chmod\s+-R\s+777\b/, description: "recursive permission loosening (chmod -R 777)" },
  { token: "shell.execute.destructive", pattern: /(?:shutdown|reboot|halt)\b(?![\w-])/, description: "system power operation" }
];

/**
 * Git operations that rewrite or discard history/state by default.
 *
 * @type {readonly string[]}
 */
export const DESTRUCTIVE_GIT_OPERATIONS = ["force-push", "reset", "clean"];

/**
 * Returns the first destructive shell pattern matched by the command
 * string, or null when the command is not classified as destructive.
 *
 * @param {string | undefined} command
 * @returns {{ token: string, description: string } | null}
 */
export function detectDestructiveShell(command) {
  if (typeof command !== "string" || command.trim() === "") return null;
  for (const entry of DESTRUCTIVE_SHELL_PATTERNS) {
    if (entry.pattern.test(command)) {
      return { token: entry.token, description: entry.description };
    }
  }
  return null;
}

/**
 * @param {string} operation
 * @returns {boolean}
 */
export function isDestructiveGitOperation(operation) {
  return DESTRUCTIVE_GIT_OPERATIONS.includes(operation);
}
