/**
 * The mechanical decision: may this concrete action run?
 *
 * Layered on the common permission model (Issue #6): the caller passes
 * the already-resolved effective permissions (role declaration crossed
 * with the profile mode — this module never widens them) and this module
 * judges the action itself, kind by kind:
 *
 * - filesystem  → role permissions (read/edit/write), optional path
 *                 prefixes, deletion refused by default
 * - shell       → refused unless the policy allows execution; dangerous
 *                 command shapes additionally require human approval
 * - git         → commit/fetch/clone/pull allowed, push and destructive
 *                 operations refused by default
 * - network     → egress only to hosts on the allow list (empty = none)
 * - external    → only services on the allow list
 * - secrets     → always refused; approvals cannot lift this
 * - any outbound surface carrying a detectable secret → refused
 *
 * @typedef {import("./contracts.js").ActionDecision} ActionDecision
 * @typedef {import("./contracts.js").ActionPolicy} ActionPolicy
 * @typedef {import("./contracts.js").ActionRequest} ActionRequest
 * @typedef {import("../permission/contracts.js").Permissions} Permissions
 */

import { detectDestructiveShell, isDestructiveGitOperation } from "./destructive.js";
import { detectSecrets } from "./secrets.js";

const FILESYSTEM_OPERATIONS = ["read", "edit", "write", "delete", "move"];

/**
 * @param {{
 *   policy: ActionPolicy,
 *   permissions: Permissions,
 *   action: ActionRequest,
 *   approvals?: readonly string[]
 * }} options
 * @returns {ActionDecision}
 */
export function decideAction({ policy, permissions, action, approvals = [] }) {
  if (!isRecord(action) || typeof action.kind !== "string" || typeof action.operation !== "string") {
    return deny("invalid_action", "action must declare a kind and an operation.");
  }

  const { kind, operation } = action;

  // Secret leakage is checked first on every outbound surface: an action
  // that would exfiltrate a credential is refused regardless of what else
  // the policy allows.
  if (["shell", "network", "external"].includes(kind)) {
    const secretKinds = detectSecrets([action.target, action.content].filter(isString).join("\n"));
    if (secretKinds.length > 0) {
      return deny("secret_leakage", `the outbound payload matches a secret shape (${secretKinds.join(", ")}); values are not echoed back.`);
    }
  }

  switch (kind) {
    case "filesystem":
      return decideFilesystem({ policy, permissions, operation, target: action.target, approvals });
    case "shell":
      return decideShell({ policy, operation, target: action.target, approvals });
    case "git":
      return decideGit({ policy, operation, approvals });
    case "network":
      return decideNetwork({ policy, operation, target: action.target });
    case "external":
      return decideExternal({ policy, operation, target: action.target });
    case "secrets":
      return deny("secrets_denied", "secrets operations are always refused; approvals cannot lift this.");
    default:
      return deny("invalid_action", `unknown action kind "${kind}".`);
  }
}

function decideFilesystem({ policy, permissions, operation, target, approvals }) {
  if (!FILESYSTEM_OPERATIONS.includes(operation)) {
    return deny("invalid_action", `unknown filesystem operation "${operation}".`);
  }

  const required = operation === "read"
    ? permissions.read
    : operation === "edit" || operation === "move"
      ? permissions.edit
      : permissions.write;

  if (required === "deny") {
    return deny("permission_denied", `the role's effective permissions deny filesystem ${operation} (read: ${permissions.read}, edit: ${permissions.edit}, write: ${permissions.write}).`);
  }

  if (operation === "delete" && policy.filesystem?.allow_delete !== true && !hasApproval(approvals, "filesystem.delete")) {
    return requiresApproval("filesystem.delete", "filesystem deletion is refused by default and requires human approval.");
  }

  const writePaths = policy.filesystem?.write_paths ?? [];
  if (operation !== "read" && writePaths.length > 0) {
    if (!isString(target) || !writePaths.some((prefix) => target === prefix || target.startsWith(`${prefix}/`) || target.startsWith(prefix))) {
      return deny("path_outside_allowed", `the target is outside the allowed write paths (${writePaths.join(", ")}).`);
    }
  }

  return allow();
}

function decideShell({ policy, operation, target, approvals }) {
  if (operation !== "execute") {
    return deny("invalid_action", `unknown shell operation "${operation}".`);
  }
  if (policy.shell?.execute !== "allow") {
    return deny("shell_disabled", "shell execution is refused by default; the policy must explicitly allow it.");
  }

  const destructive = detectDestructiveShell(target);
  if (destructive && !hasApproval(approvals, destructive.token)) {
    return requiresApproval(
      destructive.token,
      `the command matches a destructive pattern (${destructive.description}) and requires human approval.`
    );
  }

  return allow();
}

function decideGit({ policy, operation, approvals }) {
  if (isDestructiveGitOperation(operation)) {
    if (policy.git?.allow_destructive === true || hasApproval(approvals, `git.${operation}`)) {
      return allow();
    }
    return requiresApproval(`git.${operation}`, `git ${operation} rewrites or discards state and is refused by default.`);
  }

  if (operation === "push") {
    if (policy.git?.allow_push === true || hasApproval(approvals, "git.push")) {
      return allow();
    }
    return requiresApproval("git.push", "git push is refused by default and requires human approval or an explicit policy allowance.");
  }

  const safeOperations = ["commit", "fetch", "clone", "pull", "status", "diff", "log"];
  if (!safeOperations.includes(operation)) {
    return deny("invalid_action", `unknown git operation "${operation}".`);
  }
  return allow();
}

function decideNetwork({ policy, operation, target }) {
  if (operation !== "request") {
    return deny("invalid_action", `unknown network operation "${operation}".`);
  }

  const allowedHosts = policy.network?.allowed_hosts ?? [];
  const host = parseHost(target);
  if (host !== null && allowedHosts.includes(host)) {
    return allow();
  }
  return deny("egress_not_allowed", host === null
    ? "the request target does not name a host; network egress is denied by default."
    : `network egress to "${host}" is not on the allowed host list (${allowedHosts.length === 0 ? "empty" : allowedHosts.join(", ")}).`);
}

function decideExternal({ policy, operation, target }) {
  if (operation !== "invoke") {
    return deny("invalid_action", `unknown external operation "${operation}".`);
  }

  const allowedServices = policy.external?.allowed_services ?? [];
  if (isString(target) && allowedServices.includes(target)) {
    return allow();
  }
  return deny("external_service_not_allowed", `the external service is not on the allowed list (${allowedServices.length === 0 ? "empty" : allowedServices.join(", ")}).`);
}

/** Extracts the host from a URL or a bare host string; null when absent. */
function parseHost(target) {
  if (!isString(target) || target.trim() === "") return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
    try {
      return new URL(target).hostname;
    } catch {
      return null;
    }
  }
  return target.split("/")[0].split(":")[0] || null;
}

function hasApproval(approvals, token) {
  return approvals.includes(token);
}

function allow() {
  return { decision: "allow", reason: "the action is within the declared policy and the role's permissions.", code: null };
}

function deny(code, reason) {
  return { decision: "deny", reason, code, approvable: undefined };
}

function requiresApproval(token, reason) {
  return { decision: "requires_approval", reason, code: "approval_required", approvable: token };
}

function isString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
