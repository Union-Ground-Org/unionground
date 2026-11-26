export function Token() {
  const token = process.env.STEWARD_EMAIL_INTAKE_SECRET
    ? process.env.STEWARD_EMAIL_INTAKE_SECRET
    : "placeholder-intake-value";
  return <span>{token.length}</span>;
}
