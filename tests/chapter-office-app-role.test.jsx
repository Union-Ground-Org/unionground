import {act,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {App} from "../src/App.jsx";
import {fallbackData} from "./fixtures/retired-pre-bot/src/data/fallback.js";
import {primeDemoData} from "../src/data/demoData.js";
const state=vi.hoisted(()=>({props:null}));
vi.mock("../src/views/ProductHubView.jsx",()=>({ProductHubView:props=>{
  state.props=props;
  return <section><h1>Office role workflow</h1><span data-testid="acting-role">{props.connectionActor?.selectedHat}</span><span data-testid="general-staff">{String(props.staffAccess)}</span>
    {["secretary","records","treasurer","member","admin"].map(role=><button key={role} onClick={()=>props.onSelectOfficeRole(role)}>Act as {role}</button>)}
  </section>;
}}));
beforeEach(()=>{
  window.history.replaceState({},"","/m/organize/record");window.scrollTo=vi.fn();
  vi.stubGlobal("fetch",vi.fn().mockRejectedValue(new Error("offline fixture")));
  primeDemoData({...fallbackData,roles:["secretary","records","treasurer"],member:{...fallbackData.member,organizationId:"fictional-org",chapterRoles:["secretary","records","treasurer"]}});
});
afterEach(()=>{primeDemoData(fallbackData);vi.unstubAllGlobals();});
it("explicitly wears each held office, keeps generic staff controls off, and returns to Member",async()=>{
  render(<App/>);await screen.findByRole("heading",{name:"Office role workflow"});
  fireEvent.click(screen.getByRole("button",{name:"Act as secretary"}));
  await waitFor(()=>expect(screen.getByTestId("acting-role")).toHaveTextContent("secretary"));
  expect(screen.getByTestId("general-staff")).toHaveTextContent("false");
  await act(async()=>{window.history.pushState({},"","/m/tasks");window.dispatchEvent(new PopStateEvent("popstate"));});
  await waitFor(()=>expect(window.location.pathname).toBe("/m/organize/record"));
  expect(screen.getByTestId("acting-role")).toHaveTextContent("secretary");
  fireEvent.click(screen.getByRole("button",{name:"Act as admin"}));expect(screen.getByTestId("acting-role")).toHaveTextContent("secretary");
  fireEvent.click(screen.getByRole("button",{name:"Act as records"}));await waitFor(()=>expect(screen.getByTestId("acting-role")).toHaveTextContent("records"));
  fireEvent.click(screen.getByRole("button",{name:"Act as treasurer"}));await waitFor(()=>expect(screen.getByTestId("acting-role")).toHaveTextContent("treasurer"));
  expect(screen.getByTestId("general-staff")).toHaveTextContent("false");
  fireEvent.click(screen.getByRole("button",{name:"Act as member"}));await waitFor(()=>expect(screen.getByTestId("acting-role")).toHaveTextContent("member"));
  expect(window.location.pathname).toBe("/m/organize/record");
});
