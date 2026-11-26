// The real App in Chromium; the browser test swaps two modules for stand-ins.
import { createRoot } from "react-dom/client";
import { App } from "../../../src/AppRouter.jsx";
import { bootLanguage } from "../../../src/lib/bootLanguage.js";
import { loadLanguage } from "../../../src/lib/i18n.js";
import "../../../src/sg-tokens.css";
import "../../../src/styles.css";
import "../../../src/coordinator-theme.css";
import "../../../src/motion.css";
import "../../../src/popups.css";

loadLanguage(bootLanguage()).then(() => createRoot(document.getElementById("root")).render(<App />));
