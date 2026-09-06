/**
 * The common permission model shared by every runtime adapter.
 *
 * The canonical declaration lives in each agents/*.yaml as
 * `permissions: { read, edit, write }`. Adapters convert an effective
 * permission set into runtime-specific configuration (for OpenCode a
 * tools block); nothing in this module knows about any runtime.
 *
 * A profile's mode acts as a further restriction: it can deny a permission
 * the role declares, never allow one the role denies.
 *
 * @typedef {import("./contracts.js").Permissions} Permissions
 */

/**
 * @type {readonly import("./contracts.js").PermissionAction[]}
 */
export const PERMISSION_ACTIONS = ["read", "edit", "write"];

/**
 * @type {readonly import("./contracts.js").PermissionLevel[]}
 */
export const PERMISSION_LEVELS = ["allow", "deny"];

/**
 * Validates a permission declaration.
 *
 * @param {unknown} permissions
 * @returns {string[]}
 */
export function validatePermissions(permissions) {
  if (!isRecord(permissions)) {
    return ["permissions must be an object."];
  }

  const errors = [];

  for (const action of PERMISSION_ACTIONS) {
    const level = permissions[action];
    if (!PERMISSION_LEVELS.includes(level)) {
      errors.push(`permissions["${action}"] must be either "allow" or "deny".`);
    }
  }

  for (const key of Object.keys(permissions)) {
    if (!PERMISSION_ACTIONS.includes(key)) {
      errors.push(`permissions has unknown key "${key}".`);
    }
  }

  return errors;
}

/**
 * Combines the role's declared permissions with the profile's mode.
 * A "readonly" profile mode forces edit and write to deny; anything the
 * role already denies stays denied. Permissions are never widened by a
 * profile.
 *
 * @param {Permissions} permissions
 * @param {import("./contracts.js").ProfileMode} [profileMode]
 * @returns {Readonly<Permissions>}
 */
export function resolveEffectivePermissions(permissions, profileMode) {
  const deniedByProfile = profileMode === "readonly";

  return Object.freeze({
    read: permissions.read,
    edit: permissions.edit === "deny" || deniedByProfile ? "deny" : "allow",
    write: permissions.write === "deny" || deniedByProfile ? "deny" : "allow"
  });
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
