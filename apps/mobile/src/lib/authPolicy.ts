type Assurance = {
  currentLevel?: string | null;
  nextLevel?: string | null;
};

export function sessionRequiresTotp(assurance: Assurance | null): boolean {
  return Boolean(
    assurance?.nextLevel === 'aal2'
    && assurance.currentLevel !== 'aal2',
  );
}
