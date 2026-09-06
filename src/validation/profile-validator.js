/**
 * Validates semantic relationships in loaded Execution Profiles.
 * It is pure: filesystem reads and YAML parsing belong to the caller.
 *
 * Profile assignments may cover a subset of the standard agents; roles
 * without an assignment keep the runtime's default model.
 *
 * @param {readonly Record<string, unknown>[]} profiles
 * @param {{ agentNames: ReadonlySet<string> }} knownNames
 * @returns {string[]}
 */
export function validateProfileRegistry(profiles, { agentNames }) {
  const errors = [];
  const profileNames = new Set();

  for (const profile of profiles) {
    const label = typeof profile.sourcePath === "string" ? profile.sourcePath : "<unknown profile>";
    validateRequiredString(profile.name, `${label}: name`, errors);

    if (typeof profile.name === "string") {
      if (profileNames.has(profile.name)) {
        errors.push(`${label}: duplicate profile name "${profile.name}".`);
      }
      profileNames.add(profile.name);
    }

    if (!isRecord(profile.assignments)) {
      errors.push(`${label}: assignments must be an object.`);
      continue;
    }

    const roles = Object.keys(profile.assignments);
    if (roles.length === 0) {
      errors.push(`${label}: assignments must not be empty.`);
    }

    for (const role of roles) {
      if (!agentNames.has(role)) {
        errors.push(`${label}: assignments["${role}"] references unknown role "${role}".`);
      }
      validateAssignment(profile.assignments[role], `${label}: assignments["${role}"]`, errors);
    }
  }

  return errors;
}

function validateAssignment(assignment, label, errors) {
  if (!isRecord(assignment)) {
    errors.push(`${label} must be an object.`);
    return;
  }

  validateRequiredString(assignment.provider, `${label}.provider`, errors);
  validateRequiredString(assignment.model, `${label}.model`, errors);

  if (assignment.mode !== "readonly" && assignment.mode !== "write") {
    errors.push(`${label}.mode must be either "readonly" or "write".`);
  }
}

function validateRequiredString(value, label, errors) {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${label} must be a non-empty string.`);
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
