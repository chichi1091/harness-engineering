/**
 * The declarative, deny-by-default action policy and its composition.
 *
 * Policy vocabulary is deliberately small: each surface declares what is
 * explicitly allowed, everything else is refused. Composition (Profile →
 * Workflow → Step) can only narrow: an override may turn an allowance off
 * or shrink a host/path list, never widen one — the same direction the
 * permission model has used since Issue #6.
 *
 * @typedef {import("./contracts.js").ActionPolicy} ActionPolicy
 */

/**
 * Creates the default policy: shell denied, no network egress, no
 * external services, no git push, no destructive git operations, no
 * filesystem deletion, no path restrictions beyond the role permissions.
 *
 * @returns {Readonly<ActionPolicy>}
 */
export function createDefaultActionPolicy() {
  return Object.freeze({
    shell: { execute: "deny" },
    git: { allow_push: false, allow_destructive: false },
    network: { allowed_hosts: [] },
    external: { allowed_services: [] },
    filesystem: { allow_delete: false, write_paths: [] }
  });
}

/**
 * Validates a policy declaration (e.g. a Profile's `action_policy`).
 *
 * @param {unknown} policy
 * @returns {string[]}
 */
export function validateActionPolicy(policy) {
  if (policy === undefined) return [];
  if (!isRecord(policy)) {
    return ["action_policy must be an object."];
  }

  const errors = [];

  for (const key of Object.keys(policy)) {
    if (!["shell", "git", "network", "external", "filesystem"].includes(key)) {
      errors.push(`action_policy has unknown key "${key}".`);
    }
  }

  if (policy.shell !== undefined) {
    if (!isRecord(policy.shell)) {
      errors.push('action_policy.shell must be an object.');
    } else if (policy.shell.execute !== undefined && !["allow", "deny"].includes(policy.shell.execute)) {
      errors.push('action_policy.shell.execute must be either "allow" or "deny".');
    }
  }

  if (policy.git !== undefined) {
    if (!isRecord(policy.git)) {
      errors.push('action_policy.git must be an object.');
    } else {
      for (const flag of ["allow_push", "allow_destructive"]) {
        if (policy.git[flag] !== undefined && typeof policy.git[flag] !== "boolean") {
          errors.push(`action_policy.git.${flag} must be a boolean.`);
        }
      }
    }
  }

  if (policy.network !== undefined) {
    if (!isRecord(policy.network)) {
      errors.push('action_policy.network must be an object.');
    } else if (policy.network.allowed_hosts !== undefined) {
      validateStringList(policy.network.allowed_hosts, "action_policy.network.allowed_hosts", errors);
    }
  }

  if (policy.external !== undefined) {
    if (!isRecord(policy.external)) {
      errors.push('action_policy.external must be an object.');
    } else if (policy.external.allowed_services !== undefined) {
      validateStringList(policy.external.allowed_services, "action_policy.external.allowed_services", errors);
    }
  }

  if (policy.filesystem !== undefined) {
    if (!isRecord(policy.filesystem)) {
      errors.push('action_policy.filesystem must be an object.');
    } else {
      if (policy.filesystem.allow_delete !== undefined && typeof policy.filesystem.allow_delete !== "boolean") {
        errors.push("action_policy.filesystem.allow_delete must be a boolean.");
      }
      if (policy.filesystem.write_paths !== undefined) {
        validateStringList(policy.filesystem.write_paths, "action_policy.filesystem.write_paths", errors);
      }
    }
  }

  return errors;
}

/**
 * Merges an override into a base policy in the narrowing direction only:
 * booleans require both sides, host/service/path lists intersect. The
 * result can never be more permissive than either input.
 *
 * @param {ActionPolicy | undefined} base
 * @param {ActionPolicy | undefined} override
 * @returns {ActionPolicy}
 */
export function mergeActionPolicies(base, override) {
  if (!isRecord(base)) base = {};
  if (!isRecord(override)) override = {};

  return {
    shell: {
      // Both sides must allow: an override may keep or drop an allowance,
      // never introduce one the base refuses.
      execute: base.shell?.execute === "allow" && override.shell?.execute === "allow"
        ? "allow"
        : "deny"
    },
    git: {
      allow_push: (base.git?.allow_push ?? false) && (override.git?.allow_push ?? false),
      allow_destructive: (base.git?.allow_destructive ?? false) && (override.git?.allow_destructive ?? false)
    },
    network: {
      allowed_hosts: intersect(base.network?.allowed_hosts, override.network?.allowed_hosts)
    },
    external: {
      allowed_services: intersect(base.external?.allowed_services, override.external?.allowed_services)
    },
    filesystem: {
      allow_delete: (base.filesystem?.allow_delete ?? false) && (override.filesystem?.allow_delete ?? false),
      write_paths: intersect(base.filesystem?.write_paths, override.filesystem?.write_paths)
    }
  };
}

function intersect(left, right) {
  if (left === undefined || left.length === 0) return right === undefined ? [] : [...right];
  if (right === undefined || right.length === 0) return [];
  return left.filter((entry) => right.includes(entry));
}

function validateStringList(value, label, errors) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    errors.push(`${label} must be an array of non-empty strings.`);
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
