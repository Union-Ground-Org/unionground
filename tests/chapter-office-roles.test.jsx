import {fireEvent,render,screen} from "@testing-library/react";
import {describe,it,expect,vi} from "vitest";
import {LanguageProvider} from "../src/lib/LanguageContext.jsx";
import {chapterOfficeRoles,selectedChapterOfficeRole,canSelectChapterOfficeRole} from "../src/lib/chapterOfficeRoles.js";
import {ChapterOfficeRoleChoice} from "../src/features/chapterAccess/ChapterOfficeRoleChoice.jsx";
import {explicitHatAllowsView} from "../src/App.jsx";
import {readActingHat,writeActingHat} from "../src/lib/actingHat.js";
describe("limited chapter offices",()=>{
  it("requires a held and explicitly selected office, with no general staff desk",()=>{
    expect(chapterOfficeRoles()).toEqual([]);expect(chapterOfficeRoles(["admin","secretary","records"])).toEqual(["secretary","records"]);
    expect(selectedChapterOfficeRole(["secretary"],"member")).toBeNull();expect(selectedChapterOfficeRole(["secretary"],"secretary")).toBe("secretary");
    expect(canSelectChapterOfficeRole(["secretary"],true,"secretary")).toBe(false);
    expect(canSelectChapterOfficeRole(["secretary"],false,"secretary")).toBe(true);
    expect(canSelectChapterOfficeRole(["secretary"],false,"admin")).toBe(false);
    expect(canSelectChapterOfficeRole([],false,"member")).toBe(true);
    for(const hat of ["secretary","records","treasurer"]){
      expect(explicitHatAllowsView(hat,"hub",false,[hat],false,"/m/organize/record")).toBe(true);
      expect(explicitHatAllowsView(hat,"settings",false,[hat])).toBe(true);
      expect(explicitHatAllowsView(hat,"hub",false,[hat],false,"/m/organize/connections")).toBe(false);
      expect(explicitHatAllowsView(hat,"hub",false,[])).toBe(false);
      writeActingHat("fictional",hat);expect(readActingHat()).toEqual({userId:"fictional",hat});
      for(const view of ["tasks","coordinator","admin","cases","analytics"] )expect(explicitHatAllowsView(hat,view,false,[hat])).toBe(false);
    }
  });
  it("offers only granted offices, returns to Member, and labels the role in Spanish",()=>{
    const select=vi.fn();const view=render(<LanguageProvider lang="en"><ChapterOfficeRoleChoice roles={["secretary"]} selectedHat="member" onSelect={select}/></LanguageProvider>);
    expect(screen.getByLabelText("Acting role")).toHaveValue("member");expect(screen.queryByRole("option",{name:"Records only"})).toBeNull();
    fireEvent.change(screen.getByLabelText("Acting role"),{target:{value:"secretary"}});expect(select).toHaveBeenCalledWith("secretary");
    view.rerender(<LanguageProvider lang="es"><ChapterOfficeRoleChoice roles={["records"]} selectedHat="records" onSelect={select}/></LanguageProvider>);
    expect(screen.getByLabelText("Rol activo")).toHaveValue("records");
    fireEvent.change(screen.getByLabelText("Rol activo"),{target:{value:"member"}});expect(select).toHaveBeenLastCalledWith("member");
    view.rerender(<LanguageProvider lang="en"><ChapterOfficeRoleChoice roles={[]} selectedHat="member" onSelect={select}/></LanguageProvider>);expect(screen.queryByRole("combobox")).toBeNull();
    view.rerender(<LanguageProvider lang="en"><ChapterOfficeRoleChoice roles={["records"]} selectedHat="records"/></LanguageProvider>);expect(screen.queryByRole("combobox")).toBeNull();
  });
});
