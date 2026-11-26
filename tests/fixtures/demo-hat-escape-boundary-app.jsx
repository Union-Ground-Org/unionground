import { useState } from "react";
import { createRoot } from "react-dom/client";
import { DemoHatSelector } from "../../src/components/DemoHatSelector.jsx";
import { LanguageProvider } from "../../src/lib/LanguageContext.jsx";

const options = [
  { key: "member", labelKey: "demo.hatMember" },
  { key: "steward", labelKey: "demo.hatSteward" },
  { key: "coordinator", labelKey: "demo.hatCoordinator" },
];

function App() {
  const [introduce, setIntroduce] = useState(false);
  return (
    <LanguageProvider lang="en">
      {!introduce && (
        <button
          id="welcome"
          type="button"
          className="dialog-primary"
          onClick={() => setIntroduce(true)}
        >
          Continue
        </button>
      )}
      <DemoHatSelector options={options} active="steward" introduce={introduce} />
    </LanguageProvider>
  );
}

createRoot(document.getElementById("root")).render(<App />);
