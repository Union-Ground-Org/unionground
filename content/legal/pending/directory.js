// A static import makes a missing pending directory a failed web/native build.
// Vite generates the declaration manifest here; an ungenerated web module
// stays unreadable, never an empty list that could open publication. Metro
// continues to read the directory through its platform-specific loader.
export const legalPendingDirectoryPresent = true;
export const legalPendingDeclarations = null;
