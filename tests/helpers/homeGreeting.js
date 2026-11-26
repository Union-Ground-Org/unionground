// UX-UG-PHONE-HOME-GREETS-AFTERNOON-AT-EVERY-HOUR-20260920.
//
// Phone Home's h1 now greets by the member's own clock, so "Good afternoon,
// Darnell" is only the right heading between 12:00 and 17:59 local. Every
// suite below used that exact string as its "phone Home rendered" landmark,
// which made those files pass or fail on the wall clock of whoever ran them.
//
// A landmark wants the HEADING, not the time of day: this matcher accepts any
// of the three greetings and stays clock-independent. A test that cares which
// greeting is correct pins the clock instead — see
// tests/home-greeting-time.test.jsx, which is the only place the boundaries
// are asserted.
export const PHONE_HOME_GREETING = /(Good morning|Good afternoon|Good evening), Darnell/;
