import { fireEvent } from "@testing-library/react";

// REQ-UG-SIGN-IN-PROVIDER-FIRST-LAYOUT-20261105: the sign-in card
// leads with Apple and Google; the email and password form, PIN, single
// sign-on, passkey and the demo entry sit behind one "Sign in with other
// options" disclosure. Tests of those methods open it first, as a person does.
// With no provider button rendered, the methods show directly and there is no
// disclosure to open (BUG-UG-SAMPLE-SIGNIN-LONE-OTHER-OPTIONS-20261106).
export function openOtherSignInOptions(scope = document) {
  const toggle = scope.querySelector('button[aria-controls="auth-other-methods"]');
  if (!toggle) {
    const methods = scope.querySelector("#auth-other-methods");
    if (methods && !methods.hidden) return null;
    throw new Error("the sign-in card has no other-options disclosure and no direct sign-in methods");
  }
  if (toggle.getAttribute("aria-expanded") === "false") fireEvent.click(toggle);
  return toggle;
}
