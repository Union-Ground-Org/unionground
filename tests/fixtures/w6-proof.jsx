import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/sg-tokens.css";
import "../../src/styles.css";
import { LanguageProvider } from "../../src/lib/LanguageContext.jsx";
import { t } from "../../src/lib/i18n.js";
import { Button } from "../../src/components/Button.jsx";
import { Field } from "../../src/components/Field.jsx";
import { Chip } from "../../src/components/Chip.jsx";
import { SegmentedControl } from "../../src/components/SegmentedControl.jsx";
import { FilterPills } from "../../src/components/FilterPills.jsx";
import { Pager } from "../../src/components/Pager.jsx";
import { QueuePager } from "../../src/components/QueuePager.jsx";
import { PageHeader } from "../../src/components/PageHeader.jsx";
import { TrackerRow } from "../../src/components/TrackerRow.jsx";
import { TrackerStageGroup } from "../../src/components/TrackerStageGroup.jsx";
import { RoutedTabLink } from "../../src/components/WorkspacePages.jsx";

const options = [{ value: "all", label: "All", count: 30 }, { value: "open", label: "Open", count: 12 }];
const task = { id: "t1", title: "Contact members", status: "in_progress", priority: "high", dueDate: "2026-10-06", assigneeName: "Ada Lee" };
const translate = (key, vars) => t("en", key, vars);
function App() {
  const [view, setView] = useState("all"); const [filter, setFilter] = useState("open"); const [page, setPage] = useState(1);
  const row = (item) => <TrackerRow key={item} task={{ ...task, id: `t${item}`, title: `Contact members ${item}` }} chapterId="demo" t={translate} lang="en" urgency="soon" onOpenTask={() => {}} onCycleStatus={() => {}} />;
  return <LanguageProvider lang="en"><main>
    <section className="proof"><PageHeader eyebrow="Chapter" title="Shared components" purpose="One clear action, one purpose line." action={<Button>Create event</Button>} /></section>
    <section className="proof"><h2>Buttons and tabs</h2><div className="proof-row"><Button variant="primary">Primary</Button><Button variant="accent">Accent</Button><Button variant="secondary" size="small">Secondary</Button><Button variant="quiet" size="small">Quiet</Button><Button variant="destructive" size="small">Delete</Button><Button as="a" href="#fields" variant="text">Linked action</Button><RoutedTabLink group="tasks" value="list">Routed tab</RoutedTabLink></div></section>
    <section className="proof" id="fields"><h2>Field and chip</h2><Field label="Email" hint="Use your work email">{(props) => <input {...props} placeholder="name@example.org" />}</Field><div className="proof-row"><Chip tone="neutral">Neutral</Chip><Chip tone="bad">Late</Chip></div></section>
    <section className="proof"><h2>List controls</h2><div className="proof-row"><SegmentedControl label="View" options={options} value={view} onChange={setView} /><FilterPills label="Filter" options={options} value={filter} onChange={setFilter} /></div><Pager total={51} page={page} onPageChange={setPage} /><QueuePager query={{ rows: Array.from({ length: 25 }), total: 51, cursor: "next", loading: false, loadMore: () => {} }} /></section>
    <section className="proof kan-list"><h2>Tracker row and stage</h2><div className="kan-list__scroll"><div className="kan-list__inner"><ul className="kan-list__rows"><TrackerRow task={task} chapterId="demo" t={translate} lang="en" urgency="soon" onOpenTask={() => {}} onCycleStatus={() => {}} /></ul><TrackerStageGroup id="proof-stage" name="In progress" count={6} rows={[1,2,3,4,5,6]} collapsed={false} onToggle={() => {}} renderRow={row} /></div></div></section>
  </main></LanguageProvider>;
}
createRoot(document.getElementById("root")).render(<App />);
