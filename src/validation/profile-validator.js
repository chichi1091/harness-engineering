import { ESCALATION_CONDITIONS } from "../execution/model-tier.js";

/**
 * Validates semantic relationships in loaded Execution Profiles.
 * It is pure: filesystem reads and YAML parsing belong to the caller.
 *
 * Profile assignments may cover a subset of the standard agents; roles
 * without an assignment keep the runtime's default model.
 *
 * Assignments declare either a model tier ("tier") or a direct model
 * ("provider"/"model"); tier references are checked against the profile's
 * model_tiers. The conditional escalation policy (model_policy) requires
 * model_tiers, references known tiers, and must declare an escalation
 * limit so escalation stays bounded.
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

    validateModelTiers(profile.model_tiers, label, errors);
    validateModelPolicy(profile.model_policy, profile.model_tiers, label, errors);

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
      validateAssignment(profile.assignments[role], profile.model_tiers, `${label}: assignments["${role}"]`, errors);
    }
  }

  return errors;
}

/**
 * model_tiers is optional; when present it must map tier names to concrete
 * provider/model pairs so the adapter can resolve tiers to real models.
 */
function validateModelTiers(tiers, label, errors) {
  if (tiers === undefined) return;
  if (!isRecord(tiers)) {
    errors.push(`${label}: model_tiers must be an object.`);
    return;
  }

  const names = Object.keys(tiers);
  if (names.length === 0) {
    errors.push(`${label}: model_tiers must not be empty.`);
    return;
  }

  for (const name of names) {
    const tier = tiers[name];
    if (!isRecord(tier)) {
      errors.push(`${label}: model_tiers["${name}"] must be an object.`);
      continue;
    }
    validateRequiredString(tier.provider, `${label}: model_tiers["${name}"].provider`, errors);
    validateRequiredString(tier.model, `${label}: model_tiers["${name}"].model`, errors);
  }
}

/**
 * model_policy is optional; when declared it requires model_tiers (an
 * escalation points at a tier), a known condition per rule, and a
 * max_escalations bound so escalation cannot loop.
 */
function validateModelPolicy(policy, tiers, label, errors) {
  if (policy === undefined) return;
  if (!isRecord(policy)) {
    errors.push(`${label}: model_policy must be an object.`);
    return;
  }

  if (!isRecord(tiers)) {
    errors.push(`${label}: model_policy requires model_tiers.`);
  }

  if (!Array.isArray(policy.escalation) || policy.escalation.length === 0) {
    errors.push(`${label}: model_policy.escalation must be a non-empty array.`);
  } else {
    policy.escalation.forEach((rule, index) => {
      const ruleLabel = `${label}: model_policy.escalation[${index}]`;
      if (!isRecord(rule)) {
        errors.push(`${ruleLabel} must be an object.`);
        return;
      }

      if (!ESCALATION_CONDITIONS.includes(rule.when)) {
        errors.push(`${ruleLabel}.when must be one of ${ESCALATION_CONDITIONS.join(", ")}.`);
      }
      if (typeof rule.tier !== "string" || rule.tier.trim() === "") {
        errors.push(`${ruleLabel}.tier must be a non-empty string.`);
      } else if (isRecord(tiers) && !tiers[rule.tier]) {
        errors.push(`${ruleLabel}.tier references unknown tier "${rule.tier}".`);
      }
    });
  }

  if (typeof policy.max_escalations !== "number" || !Number.isInteger(policy.max_escalations) || policy.max_escalations < 1) {
    errors.push(`${label}: model_policy.max_escalations must be an integer greater than or equal to 1.`);
  }
}

function validateAssignment(assignment, tiers, label, errors) {
  if (!isRecord(assignment)) {
    errors.push(`${label} must be an object.`);
    return;
  }

  if (assignment.tier !== undefined) {
    if (assignment.provider !== undefined || assignment.model !== undefined) {
      errors.push(`${label} must declare either "tier" or "provider"/"model", not both.`);
      return;
    }
    if (typeof assignment.tier !== "string" || assignment.tier.trim() === "") {
      errors.push(`${label}.tier must be a non-empty string.`);
      return;
    }
    if (isRecord(tiers) && !tiers[assignment.tier]) {
      errors.push(`${label}.tier references unknown tier "${assignment.tier}".`);
    }
  } else {
    validateRequiredString(assignment.provider, `${label}.provider`, errors);
    validateRequiredString(assignment.model, `${label}.model`, errors);
  }

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
