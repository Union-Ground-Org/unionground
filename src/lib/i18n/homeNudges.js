import { homeNudgesCatalogueSpanish } from "./locales/es/namespaces/homeNudges.js";
// Member Home nudges (REQ-UG-HOME-NUDGES-20261001), split out of the
// src/lib/i18n.js barrel like getApp.js. This file is the ONLY declaration of
// every `homeNudge.` key and of this record's `settings.def.` keys; the barrel
// spreads it back into `catalogue`, so `t()` is unchanged.
export const homeNudgesCatalogue = {
  en: {
    "homeNudge.onboardingTitle": "Complete your onboarding",
    "homeNudge.onboardingBody": "Step {step} of {total}. Pick up your checklist where you left off.",
    "homeNudge.onboardingAction": "Continue onboarding",
    "homeNudge.starterTitle": "New here? Start with these 4 steps",
    "homeNudge.starterBody": "Your campaign has not added its own onboarding checklist yet, so here is where most new workers start.",
    "homeNudge.starterAction": "See the 4 steps",
    "homeNudge.passkeyTitle": "Sign in faster with a passkey",
    "homeNudge.passkeyBody": "Use Face ID, Touch ID, Windows Hello or a security key instead of typing your password.",
    "homeNudge.passkeyAction": "Add a passkey",
    "homeNudge.passwordTitle": "Choose your own password",
    "homeNudge.passwordBody": "You are still signing in with the password we emailed you. Choose one only you know in Settings, under Security.",
    "homeNudge.passwordAction": "Choose a password",
    "homeNudge.notNowPassword": "Not now: hide the password reminder",
    "homeNudge.notNow": "Not now",
    "homeNudge.notNowOnboarding": "Not now: hide the onboarding reminder for a while",
    "homeNudge.notNowStarter": "Not now: hide the getting-started steps",
    "homeNudge.notNowPasskey": "Not now: hide the passkey suggestion for a while",
    "settings.def.features.home.passkey_nudge.label": "Passkey nudge on Home",
    "settings.def.features.home.passkey_nudge.description": "Suggest adding a passkey to members who have none, when passkey enrollment is on. Shown one nudge at a time, never during the welcome tour.",
    "settings.def.features.home.onboarding_nudge.label": "Onboarding nudge on Home",
    "settings.def.features.home.onboarding_nudge.description": "Remind workers with an unfinished onboarding checklist to continue it. Shown one nudge at a time, never during the welcome tour.",
    "settings.def.limits.home.nudge_snooze_days.label": "Snooze a dismissed Home nudge (days)",
    "settings.def.limits.home.nudge_snooze_days.description": "Days a Home nudge stays hidden on a device after the worker chooses Not now.",
  },
  get es() { return homeNudgesCatalogueSpanish; },
};
