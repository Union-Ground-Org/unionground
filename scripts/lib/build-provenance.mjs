const EXACT_SHA = /^[0-9a-f]{40}$/;
const ZERO_SHA = /^0{40}$/;

export function assertExactBuildSha(value) {
  if (!EXACT_SHA.test(value ?? "") || ZERO_SHA.test(value)) {
    throw new Error("Build marker requires a nonzero exact lowercase commit SHA");
  }
  return value;
}
