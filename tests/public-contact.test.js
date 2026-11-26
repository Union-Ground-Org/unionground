import { describe, expect, it } from "vitest";
import * as publicContactModule from "../src/lib/publicContact.js";
import { PUBLIC_CONTACTS, PUBLIC_POSTAL_ADDRESS, publicContact } from "../src/lib/publicContact.js";

// Union Ground has published no company statement, mailbox or postal
// address yet. The contact module carries none, never the sibling product's
// company name, mailing address or aliases, and every caller asks the one
// resolver, which answers null until an owner-approved contact exists.
describe("public contact values", () => {
  it("publishes no postal address and freezes the empty contact table", () => {
    expect(PUBLIC_POSTAL_ADDRESS).toBeNull();
    expect(PUBLIC_CONTACTS).toEqual({});
    expect(Object.isFrozen(PUBLIC_CONTACTS)).toBe(true);
    expect(() => { PUBLIC_CONTACTS.owner = { email: "x@example.invalid" }; }).toThrow(TypeError);
    expect(Object.keys(publicContactModule).sort()).toEqual(["PUBLIC_CONTACTS", "PUBLIC_POSTAL_ADDRESS", "publicContact"]);
  });

  it("answers null for every role and invents no address", () => {
    for (const role of ["owner", "sales", "support", "privacy", "toString", "__proto__", ""]) {
      expect(publicContact(role), role).toBeNull();
    }
  });
});
