import { ArrowLeft, ShieldCheck } from "lucide-react";
import { BrandWordmark } from "../components/BrandMark.jsx";

export function RetiredLegacyView() {
  return (
    <div className="public-site">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <header className="public-header">
        <a className="public-brand" href="/" aria-label="Union Ground home"><BrandWordmark /></a>
      </header>
      <main id="main-content" className="public-cta">
        <ShieldCheck size={38} aria-hidden="true" />
        <span>Provider boundary</span>
        <h1>This inherited page is not part of Union Ground.</h1>
        <p>The old design package and ContractSurvey wrapper are intentionally unavailable from this application.</p>
        <a className="public-primary" href="/"><ArrowLeft size={17} aria-hidden="true" /> Return home</a>
      </main>
    </div>
  );
}
