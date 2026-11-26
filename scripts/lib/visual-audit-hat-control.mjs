import { CovenantAssertionError } from "./demo-chrome-covenant.mjs";

export async function clickVisibleTopHatOption({
  option,
  trigger,
  attempts = 10,
  waitTimeoutMs = 1000,
  beforeOptionClick = () => {},
}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await option.isVisible().catch(() => false)) {
      await beforeOptionClick();
      await option.click({ timeout: waitTimeoutMs });
      return;
    }
    await trigger.click({ timeout: waitTimeoutMs });
    await option.waitFor({ state: "visible", timeout: waitTimeoutMs }).catch(() => {});
  }
  await beforeOptionClick();
  await option.click({ timeout: waitTimeoutMs });
}

export async function selectVisibleHatControl({
  select,
  hat,
  expandedOption,
  option,
  trigger,
  attempts = 30,
  timeoutMs = 30000,
  retryDelayMs = 100,
  waitForRetry = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  beforeSelectionAttempt = () => {},
  afterSelectionAttemptFailure = () => {},
}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const actionTimeoutMs = Math.min(1000, Math.max(1, deadline - Date.now()));
    let selectionAttemptStarted = false;
    const beginSelectionAttempt = async () => {
      selectionAttemptStarted = true;
      await beforeSelectionAttempt();
    };
    try {
      if (await select.isVisible().catch(() => false)) {
        await beginSelectionAttempt();
        await select.selectOption(hat, { timeout: actionTimeoutMs });
        return "phone-select";
      }
      if (await expandedOption.isVisible().catch(() => false)) {
        await beginSelectionAttempt();
        await expandedOption.click({ timeout: actionTimeoutMs });
        return "expanded-option";
      }
      if (await option.isVisible().catch(() => false)) {
        await beginSelectionAttempt();
        await option.click({ timeout: actionTimeoutMs });
        return "top-option";
      }
      if (await trigger.isVisible().catch(() => false)) {
        await clickVisibleTopHatOption({
          option,
          trigger,
          attempts: 1,
          waitTimeoutMs: actionTimeoutMs,
          beforeOptionClick: beginSelectionAttempt,
        });
        return "top-option";
      }
    } catch (error) {
      lastError = error;
      if (selectionAttemptStarted) await afterSelectionAttemptFailure();
    }

    const remainingMs = deadline - Date.now();
    if (attempt + 1 >= attempts || remainingMs <= 0) break;
    await waitForRetry(Math.min(retryDelayMs, remainingMs));
  }

  throw lastError ?? new Error(`Unable to select ${hat} from a visible SAMPLE hat control`);
}

export async function observeVisibleSelectedHatControl({
  select,
  selectedOption,
  hat,
  expandedOption,
  trigger,
  label,
}) {
  if (await select.isVisible().catch(() => false)) {
    const actual = await select.inputValue();
    return {
      shape: "phone-select",
      selected: actual === hat,
      label: (await selectedOption.textContent().catch(() => ""))?.trim() || null,
      value: actual || null,
    };
  }
  if (await expandedOption.isVisible().catch(() => false)) {
    const actualLabel = (await expandedOption.innerText()).trim();
    return {
      shape: "expanded-option",
      selected: await expandedOption.getAttribute("aria-pressed") === "true" && actualLabel === label,
      label: actualLabel || null,
      value: null,
    };
  }
  if (await trigger.isVisible().catch(() => false)) {
    const actualLabel = (await trigger.innerText()).trim();
    return {
      shape: "top-trigger",
      selected: actualLabel === label,
      label: actualLabel || null,
      value: null,
    };
  }
  return { shape: null, selected: false, label: null, value: null };
}

export async function waitForVisibleSelectedHatControl({
  attempts = Number.POSITIVE_INFINITY,
  timeoutMs = 30000,
  retryDelayMs = 100,
  waitForRetry = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  ...controls
}) {
  const deadline = Date.now() + timeoutMs;
  let observation = { shape: null, selected: false, label: null, value: null };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    observation = await observeVisibleSelectedHatControl(controls);
    if (observation.selected) return observation;
    const remainingMs = deadline - Date.now();
    if (attempt + 1 >= attempts || remainingMs <= 0) break;
    await waitForRetry(Math.min(retryDelayMs, remainingMs));
  }
  throw new CovenantAssertionError(`Hat mismatch after SAMPLE shell settled: expected ${controls.label} (${controls.hat}); observed ${JSON.stringify(observation)}`);
}
