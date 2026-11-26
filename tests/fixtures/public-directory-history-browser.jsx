import { createRoot } from "react-dom/client";
import { App } from "../../src/AppRouter.jsx";
import "../../src/sg-tokens.css";
import "../../src/styles.css";

createRoot(document.getElementById("root")).render(<App />);
