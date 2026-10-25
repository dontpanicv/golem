/** Something Golem needs from the machine it runs on, checked before it starts. */
export interface Requirement {
  readonly name: string;
  /** What Golem uses it for. */
  readonly purpose: string;
  /** How to get it when it is missing. */
  readonly install: string;
  /** What is wrong, or `null` when it is there. */
  readonly problem: string | null;
}

/** A program that Golem runs, found on `PATH`. */
export function program(
  name: string,
  purpose: string,
  install: string
): Requirement {
  return {
    name,
    purpose,
    install,
    problem: Bun.which(name) ? null : "not found on PATH",
  };
}

/** Prints one line per requirement; returns whether all of them are there. */
export function reportRequirements(requirements: readonly Requirement[]) {
  for (const requirement of requirements) {
    console.log(
      requirement.problem
        ? `✗ ${requirement.name} (${requirement.purpose}): ${requirement.problem}. Install: ${requirement.install}`
        : `✓ ${requirement.name} (${requirement.purpose})`
    );
  }
  return requirements.every((requirement) => !requirement.problem);
}
