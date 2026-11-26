// Binding the read to a const first does not change what is being defaulted.
const configured = process.env.STEWARD_EMAIL_INTAKE_SECRET;

export const intakeSecret = configured || "placeholder-intake-value";
