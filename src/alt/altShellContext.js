import { createContext, useContext } from "react";

// What the alternate chrome offers the pages mounted inside it: a way to open
// the chapter rail ("Change chapters" on the Now page) and the menu. Pages
// render without it too, so the Now page can be tested on its own.
export const AltShellContext = createContext(null);

export function useAltShell() {
  return useContext(AltShellContext);
}
