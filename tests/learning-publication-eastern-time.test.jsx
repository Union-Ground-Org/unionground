import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatLearningInstant, instantFromLocalInput } from "../src/features/learningContent/time.js";
import { LearningPublicationPanel } from "../src/features/learningContent/LearningPublicationPanel.jsx";
import { LearningHistoryPanel } from "../src/features/learningContent/LearningHistoryPanel.jsx";
import { learningContentCopy } from "../src/lib/i18n/learningContent.js";
import { normalizeLearningItem } from "../src/features/learningContent/model.js";

const winter="2026-11-11T16:51:42.123456+00:00";
const summer="2026-07-15T16:51:00Z";
const item = normalizeLearningItem({id:"lesson",kind:"quote",locale:"en",locale_state:"reviewed",scope:"chapter",audience:"all",priority:0,status:"scheduled",revision:2,title:"Fixture quote",body:"A reviewed quote.",rights_note:"Written for this fixture.",review_note:"Reviewed.",starts_at:winter,ends_at:null});
afterEach(() => vi.useRealTimers());

describe("Eastern publication clocks", () => {
  it.each(["en","es"])("formats winter and summer instants in %s", (lang) => {
    expect(formatLearningInstant(winter,lang)).toMatch(/11:51.*EST$/);
    expect(formatLearningInstant(summer,lang)).toMatch(/12:51.*EDT$/);
    expect(formatLearningInstant(winter,lang)).toMatch(lang==="es"?/11 nov 2026.*a\.\s*m\./:/Nov 11, 2026.*AM/);
    expect(formatLearningInstant(summer,lang)).toMatch(lang==="es"?/15 jul 2026.*p\.\s*m\./:/Jul 15, 2026.*PM/);
    expect(formatLearningInstant(0,lang)).toMatch(/EST$/);
  });
  it.each([null,undefined,"","bad","2026-11-11T16:51",1e20])("does not invent a clock for %s", (value) => {
    expect(formatLearningInstant(value,"en")).toBe("");
  });
  it.each(["en","es"])("shows scheduled/live-until states and preserves exact history datetime in %s", async(lang)=>{
    vi.useFakeTimers({toFake:["Date"],now:new Date("2026-11-09T17:00:00Z")});
    const tr=learningContentCopy(lang),scope={locale:lang,chapterId:"fixture",userId:"author"};
    const panel=render(<LearningPublicationPanel api={{}} scope={scope} item={item} dirty={false} tr={tr} />);
    expect(panel.container.querySelector('.lc-publication__state')).toHaveTextContent(/11:51.*EST/);
    panel.rerender(<LearningPublicationPanel api={{}} scope={scope} item={{...item,status:"published",starts_at:"2026-11-01T17:00:00Z",ends_at:winter}} dirty={false} tr={tr} />);
    expect(panel.container.querySelector('.lc-publication__state')).toHaveTextContent(lang==="es"?/Visible hasta.*11:51.*EST/:/Visible until.*11:51.*EST/);
    panel.unmount();
    const api={getHistory:vi.fn().mockResolvedValue({items:[{revision:2,action:"schedule",changedAt:winter,changedBy:"author"}],hasMore:false})};
    render(<LearningHistoryPanel api={api} scope={scope} item={item} tr={tr} onCopy={vi.fn()} />);
    fireEvent.click(screen.getByRole("button",{name:tr("history.show")}));
    await waitFor(()=>expect(document.querySelector('time')).toHaveTextContent(/11:51.*EST/));
    expect(document.querySelector('time')).toHaveAttribute('datetime',winter);
  });
  it.each(["en","es"])("names the local input zone separately and submits that zone's actual instant in %s",async(lang)=>{
    vi.useFakeTimers({toFake:["Date"],now:new Date("2026-11-09T17:00:00Z")});
    const zone=Intl.DateTimeFormat().resolvedOptions().timeZone;
    const tr=learningContentCopy(lang),api={transition:vi.fn().mockResolvedValue(item)};
    render(<LearningPublicationPanel api={api} scope={{locale:lang,chapterId:"fixture"}} item={{...item,status:"draft"}} dirty={false} tr={tr} onChanged={vi.fn()} />);
    const caption=screen.getByText(tr("publish.timeZone",{timezone:zone}));
    expect(caption).toHaveTextContent(zone);
    expect(caption).toHaveTextContent(/ET/);
    const starts=screen.getByLabelText(tr("publish.startsAt"));
    expect(starts.getAttribute("aria-describedby").split(" ")).toContain(caption.id);
    fireEvent.change(starts,{target:{value:"2026-11-18T13:00"}});
    fireEvent.click(screen.getByRole("button",{name:tr("publish.schedule")}));
    const expected={"America/New_York":"2026-11-18T18:00:00.000Z","America/Los_Angeles":"2026-11-18T21:00:00.000Z","Asia/Tokyo":"2026-11-18T04:00:00.000Z",UTC:"2026-11-18T13:00:00.000Z"}[zone];
    expect(instantFromLocalInput("2026-11-18T13:00")).toBe(expected);
    await waitFor(()=>expect(api.transition).toHaveBeenCalledWith(expect.objectContaining({startsAt:expected,endsAt:null,action:"schedule"})));
  });
});
