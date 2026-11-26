/* global CSS, document, window */

export const VISUAL_RULES = Object.freeze({
  HORIZONTAL_OVERFLOW: "horizontal-overflow",
  ELEMENT_COLLISION: "element-collision",
  CLIPPED_INTERACTIVE: "clipped-interactive",
  SMALL_TARGET: "small-target",
  BROKEN_IMAGE: "broken-image",
  DIALOG_VIEWPORT: "dialog-viewport",
  FIXED_OBSTRUCTION: "fixed-obstruction",
  FOCUS_HIDDEN: "focus-hidden",
});

const GEOMETRY_EPSILON = 0.5;
const intersectionSize = (a, b) => ({
  width: Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)),
  height: Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)),
});
const intersects = (a, b) => {
  const size = intersectionSize(a, b);
  return size.width > GEOMETRY_EPSILON && size.height > GEOMETRY_EPSILON;
};
const contains = (a, b) => a.left <= b.left && a.top <= b.top && a.right >= b.right && a.bottom >= b.bottom;
const intersectionRect = (a, b) => {
  if (!intersects(a, b)) return null;
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);
  return { left, top, right, bottom, width: right - left, height: bottom - top };
};

const copyRect = (rect) => rect && ({
  left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
  width: rect.width, height: rect.height,
});

const visibleInViewport = (rect, viewport) => rect && intersects(rect, {
  left: 0,
  top: 0,
  right: viewport.width,
  bottom: viewport.height,
});

function sameSelectors(actual = [], expected = []) {
  return actual.length === expected.length && actual.every((selector, index) => selector === expected[index]);
}

function baselineMatches(finding, entry) {
  return entry?.route === finding.route
    && entry.rule === finding.rule
    && entry.selector === finding.selector
    && Number(entry.viewport?.width) === Number(finding.viewport?.width)
    && Number(entry.viewport?.height) === Number(finding.viewport?.height)
    && sameSelectors(entry.selectors || [entry.selector], finding.selectors || [finding.selector])
    && (entry.obstruction || null) === (finding.obstruction || null);
}

function findingSeverity(finding) {
  if (finding.rule === VISUAL_RULES.SMALL_TARGET) {
    const rect = finding.rectangles?.[0] || {};
    return Math.max(0, 44 - Number(rect.width || 0)) + Math.max(0, 44 - Number(rect.height || 0));
  }
  if ([VISUAL_RULES.ELEMENT_COLLISION, VISUAL_RULES.FIXED_OBSTRUCTION].includes(finding.rule)) {
    return Number(finding.intersectionRect?.width || 0) * Number(finding.intersectionRect?.height || 0);
  }
  if (finding.rule === VISUAL_RULES.CLIPPED_INTERACTIVE) {
    const [rect, clipRect] = finding.rectangles || [];
    if (!rect || !clipRect) return 0;
    const overlap = intersectionSize(rect, clipRect);
    return Math.max(0, Number(rect.width) * Number(rect.height) - overlap.width * overlap.height);
  }
  return 0;
}

function baselineIdentity(finding) {
  return {
    rule: finding.rule,
    route: finding.route,
    viewport: {
      width: Number(finding.viewport?.width || 0),
      height: Number(finding.viewport?.height || 0),
    },
    selector: finding.selector,
    selectors: finding.selectors || [finding.selector],
    ...(finding.obstruction ? { obstruction: finding.obstruction } : {}),
  };
}

export function createVisualBaseline(findings = []) {
  const grouped = new Map();
  for (const finding of findings) {
    const identity = baselineIdentity(finding);
    const key = JSON.stringify(identity);
    const current = grouped.get(key) || { ...identity, maxOccurrences: 0, maxSeverity: 0 };
    current.maxOccurrences += 1;
    current.maxSeverity = Math.max(current.maxSeverity, findingSeverity(finding));
    grouped.set(key, current);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, entry]) => entry);
}

export async function settleVisualAuditSurface(page, timeout = 30000, options = {}) {
  const startedAt = Date.now();
  const remainingTimeout = (step) => {
    const remaining = timeout - (Date.now() - startedAt);
    if (remaining < 1) throw new Error(`Visual audit surface did not settle before ${step}`);
    return remaining;
  };
  await page.addStyleTag({ content: `
    *, *::before, *::after {
      animation: none !important;
      transition: none !important;
      scroll-behavior: auto !important;
      caret-color: transparent !important;
    }
  ` });
  await page.locator("nav.desktop-rail, .card-nav__panel--home, .home-orb").first()
    .waitFor({ state: "visible", timeout: remainingTimeout("the app shell became visible") });
  // The shell can render before the route's lazy chunk. Measuring that
  // Suspense fallback made the audit depend on runner/network timing: the
  // local run and GitHub saw different subsets of the hydrated navigation.
  // Several Suspense fallbacks can be mounted at once (shell + route + dialog
  // chunks), so a single strict locator throws on more than one match. Wait
  // until no loading surface is visible at all instead of on the first match.
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll(".loading-screen, .view-loading"))
      .every((element) => element.getClientRects().length === 0),
    null,
    { timeout: remainingTimeout("the route finished hydrating") },
  );
  // Dialogs are a separate lazy chunk from the active route. On the SAMPLE
  // front door, wait for the expected welcome layer to hydrate before
  // dismissing it; checking only once when the shell appears races that chunk
  // and leaves the modal covering the surface being audited. Host-gated
  // SAMPLE origins do not use ?demo=1, so the query is not the only signal.
  const welcome = page.locator(".demo-welcome-layer");
  const currentUrl = new URL(page.url());
  const onMemberHome = currentUrl.pathname.replace(/\/+$/, "") === "/m"
    && currentUrl.searchParams.get("embed") !== "phone";
  const sampleChrome = page.locator(".demo-bar, .desktop-rail__hat-switcher");
  const expectsWelcome = options.expectWelcome === false
    ? false
    : onMemberHome && (
      currentUrl.searchParams.get("demo") === "1"
      || options.expectWelcome === true
      || await sampleChrome.first().isVisible().catch(() => false)
    );
  if (expectsWelcome) {
    await welcome.waitFor({ state: "visible", timeout: remainingTimeout("the demo welcome layer hydrated") });
  }
  if (await welcome.isVisible().catch(() => false)) {
    await welcome.locator(".demo-welcome__actions .dialog-primary, .dialog-primary").first().click();
    await welcome.waitFor({ state: "hidden", timeout: remainingTimeout("the welcome layer closed") });
  }

  const stabilityTimeout = remainingTimeout("layout stability was observed");
  const quietWindow = Math.min(300, Math.max(50, Math.floor(stabilityTimeout / 4)));
  await page.evaluate(async ({ quietWindowMs, timeoutMs }) => {
    const deadline = performance.now() + timeoutMs;
    const timeoutError = () => new Error(`Visual audit layout did not remain stable for ${quietWindowMs}ms`);
    const waitForFonts = document.fonts?.ready;
    if (waitForFonts) {
      await Promise.race([
        waitForFonts,
        new Promise((_, reject) => window.setTimeout(() => reject(timeoutError()), timeoutMs)),
      ]);
    }

    const measuredSelector = [
      "body", "main", "nav", "[role='dialog']", "[role='status']",
      "a", "button", "input", "select", "textarea", "summary",
      "h1", "h2", "h3", "img",
    ].join(",");
    const rounded = (value) => Math.round(Number(value || 0) * 2) / 2;
    const signature = () => {
      const root = document.documentElement;
      const elements = [...document.querySelectorAll(measuredSelector)];
      const geometry = elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return [
          element.tagName,
          element.id,
          element.getAttribute("class") || "",
          element.childElementCount,
          rounded(rect.left),
          rounded(rect.top),
          rounded(rect.width),
          rounded(rect.height),
          element.tagName === "IMG" ? `${element.complete}:${element.naturalWidth}` : "",
        ].join(":");
      });
      return [
        document.getElementsByTagName("*").length,
        rounded(root.scrollWidth),
        rounded(root.scrollHeight),
        document.fonts?.status || "unsupported",
        ...geometry,
      ].join("|");
    };

    await new Promise((resolveStable, rejectStable) => {
      let previous = signature();
      let unchangedSince = performance.now();
      const sample = () => {
        const now = performance.now();
        if (now >= deadline) {
          rejectStable(timeoutError());
          return;
        }
        const current = signature();
        if (current !== previous) {
          previous = current;
          unchangedSince = now;
        }
        if (now - unchangedSince >= quietWindowMs) {
          resolveStable();
          return;
        }
        window.setTimeout(sample, 50);
      };
      window.setTimeout(sample, Math.min(50, quietWindowMs));
    });
  }, { quietWindowMs: quietWindow, timeoutMs: stabilityTimeout });
}

// Confirmation toasts belong to the action that produced them, not to the
// stable route surface. A write can refresh the route after an external
// persistence check has already completed, so wait through a quiet interval
// instead of treating one moment without a toast as settled.
export async function waitForVisualToastsToClear(page, timeout = 8000, quietWindow = 350) {
  if (!Number.isFinite(timeout) || timeout < 1) throw new Error("Visual toast timeout must be positive");
  if (!Number.isFinite(quietWindow) || quietWindow < 0) throw new Error("Visual toast quiet window cannot be negative");
  await page.evaluate(async ({ timeoutMs, quietWindowMs }) => {
    const deadline = performance.now() + timeoutMs;
    const isVisible = (node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return !node.hidden && style.display !== "none" && style.visibility !== "hidden"
        && style.opacity !== "0" && rect.width > 0 && rect.height > 0;
    };
    let clearSince = null;
    while (performance.now() < deadline) {
      const now = performance.now();
      if ([...document.querySelectorAll(".toast")].some(isVisible)) {
        clearSince = null;
      } else if (clearSince === null) {
        clearSince = now;
      } else if (now - clearSince >= quietWindowMs) {
        return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    }
    throw new Error(`Visual toast did not remain clear for ${quietWindowMs}ms`);
  }, { timeoutMs: timeout, quietWindowMs: quietWindow });
}

export function applyVisualBaseline(report, baseline = []) {
  const occurrences = new Map();
  const failures = [];
  const warnings = [...(report.warnings || [])];
  for (const finding of report.failures || []) {
    const entryIndex = baseline.findIndex((entry) => baselineMatches(finding, entry));
    if (entryIndex < 0) {
      failures.push(finding);
      continue;
    }
    const occurrence = (occurrences.get(entryIndex) || 0) + 1;
    occurrences.set(entryIndex, occurrence);
    const entry = baseline[entryIndex];
    const withinCount = occurrence <= Number(entry.maxOccurrences || 0);
    const withinSeverity = findingSeverity(finding) <= Number(entry.maxSeverity || 0) + GEOMETRY_EPSILON;
    if (!withinCount || !withinSeverity) {
      failures.push(finding);
      continue;
    }
    warnings.push({ ...finding, severity: "warning", baseline: true });
  }
  return { ...report, failures, warnings };
}

function ignored(finding, measurements, exceptions) {
  const route = measurements.route || measurements.url || "";
  return exceptions.some((exception) => exception
    && exception.route === route
    && exception.rule === finding.rule
    && exception.selector === finding.selector
    && (!finding.obstruction || exception.obstruction === finding.obstruction));
}

function addFinding(target, finding, measurements, exceptions) {
  if (ignored(finding, measurements, exceptions)) return;
  target.push({ ...finding, severity: target === measurements.__failures ? "failure" : "warning" });
}

export function classifyVisualMeasurements(measurements, exceptions = []) {
  const failures = [];
  const warnings = [];
  const context = {
    route: measurements.route || measurements.url || "",
    viewport: { ...(measurements.viewport || { width: 0, height: 0 }) },
  };
  const contextualMeasurements = { ...measurements, __failures: failures };
  const viewport = measurements.viewport || { width: 0, height: 0 };
  const elements = (measurements.elements || []).filter((element) => element
    && !element.hidden && !element.decorative && element.kind !== "decorative" && element.rect
    && Number(element.rect.width) > 0 && Number(element.rect.height) > 0);
  const finding = (rule, selector, message, extra = {}) => ({
    rule,
    selector,
    selectors: extra.selectors || (selector ? [selector] : []),
    rectangles: extra.rectangles || [],
    explanation: message,
    message,
    ...context,
    ...extra,
  });

  if (Number(measurements.document?.scrollWidth) > Number(viewport.width)) {
    addFinding(failures, finding(VISUAL_RULES.HORIZONTAL_OVERFLOW, "document", "Document is wider than the viewport."), contextualMeasurements, exceptions);
  }

  for (let index = 0; index < elements.length; index += 1) {
    const left = elements[index];
    if (left.kind === "interactive" && visibleInViewport(left.rect, viewport)
      && (left.rect.width + GEOMETRY_EPSILON < 44 || left.rect.height + GEOMETRY_EPSILON < 44)) {
      addFinding(failures, finding(VISUAL_RULES.SMALL_TARGET, left.selector, "Interactive target is smaller than 44×44 CSS pixels.", {
        rectangles: [copyRect(left.rect)],
      }), contextualMeasurements, exceptions);
    }
    for (let next = index + 1; next < elements.length; next += 1) {
      const right = elements[next];
      if (!visibleInViewport(left.rect, viewport) || !visibleInViewport(right.rect, viewport)) continue;
      const leftOverlay = left.kind === "overlay" || Boolean(left.overlayAncestor)
        || left.kind === "container" && ["absolute", "fixed", "sticky"].includes(left.positioning);
      const rightOverlay = right.kind === "overlay" || Boolean(right.overlayAncestor)
        || right.kind === "container" && ["absolute", "fixed", "sticky"].includes(right.positioning);
      const overlay = leftOverlay || rightOverlay;
      const ancestorPair = (left.domAncestors || []).includes(right.selector)
        || (right.domAncestors || []).includes(left.selector);
      if (!intersects(left.rect, right.rect) || ancestorPair
        || (!overlay && (contains(left.rect, right.rect) || contains(right.rect, left.rect)))) continue;
      const selector = overlay
        ? (leftOverlay ? left.overlayAncestor || left.selector : right.overlayAncestor || right.selector)
        : left.selector;
      const collision = finding(VISUAL_RULES.ELEMENT_COLLISION, selector, "Visible elements overlap outside normal containment.", {
        selectors: [left.selector, right.selector],
        rectangles: [copyRect(left.rect), copyRect(right.rect)],
        intersectionRect: intersectionRect(left.rect, right.rect),
      });
      addFinding(overlay ? warnings : failures, collision, contextualMeasurements, exceptions);
    }
  }

  for (const item of measurements.clipped || []) {
    if (item?.selector && (!item.rect || visibleInViewport(item.rect, viewport))) addFinding(failures, finding(VISUAL_RULES.CLIPPED_INTERACTIVE, item.selector, "Interactive content is clipped.", {
      rectangles: [copyRect(item.rect), copyRect(item.clipRect)].filter(Boolean),
      selectors: [item.selector, item.clipper].filter(Boolean),
      clipper: item.clipper,
      intersectionRect: item.rect && item.clipRect ? intersectionRect(item.rect, item.clipRect) : null,
    }), contextualMeasurements, exceptions);
  }
  for (const item of measurements.brokenImages || []) {
    if (item?.selector) addFinding(failures, finding(VISUAL_RULES.BROKEN_IMAGE, item.selector, "Image failed to load.", {
      rectangles: [copyRect(item.rect)].filter(Boolean),
    }), contextualMeasurements, exceptions);
  }
  for (const dialog of measurements.dialogs || []) {
    const rect = dialog?.rect;
    if (rect && (rect.left < 0 || rect.top < 0 || rect.right > viewport.width || rect.bottom > viewport.height)) {
      addFinding(failures, finding(VISUAL_RULES.DIALOG_VIEWPORT, dialog.selector, "Dialog is outside the viewport.", {
        rectangles: [copyRect(rect)],
      }), contextualMeasurements, exceptions);
    }
  }
  if (measurements.focus?.hidden) {
    addFinding(failures, finding(VISUAL_RULES.FOCUS_HIDDEN, measurements.focus.selector, "Focused element is hidden.", {
      rectangles: [copyRect(measurements.focus.rect)].filter(Boolean),
    }), contextualMeasurements, exceptions);
  }
  for (const obstruction of measurements.fixedObstructions || []) {
    if (!visibleInViewport(obstruction.rect, viewport)) continue;
    for (const element of elements) {
      const hasPaintedRect = Object.prototype.hasOwnProperty.call(element, "paintedRect");
      const paintedRect = hasPaintedRect ? element.paintedRect : element.rect;
      if (element.selector === obstruction.selector
        || !["interactive", "text"].includes(element.kind)
        || !paintedRect
        || !visibleInViewport(paintedRect, viewport)
        || !intersects(obstruction.rect, paintedRect)) continue;
      const hasAncestry = Object.prototype.hasOwnProperty.call(element, "domAncestors");
      const obstructionAncestors = obstruction.domAncestors || [];
      if (hasAncestry && (element.domAncestors.includes(obstruction.selector)
        || obstructionAncestors.includes(element.selector))) continue;
      const target = hasAncestry ? failures : warnings;
      addFinding(target, finding(VISUAL_RULES.FIXED_OBSTRUCTION, element.selector, hasAncestry
        ? "Fixed or sticky content obstructs meaningful content."
        : "Fixed or sticky content may obstruct meaningful content; DOM ancestry is unavailable.", {
        obstruction: obstruction.selector,
        selectors: [element.selector, obstruction.selector],
        rectangles: [copyRect(paintedRect), copyRect(obstruction.rect)],
        intersectionRect: intersectionRect(paintedRect, obstruction.rect),
      }), contextualMeasurements, exceptions);
    }
  }
  return { failures, warnings, inspected: elements.length };
}

/** Serializable browser collector: pass this function directly to page.evaluate. */
export function collectVisualMeasurements() {
  const root = document.documentElement;
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  // Browserbase and local Chromium can disagree by a few millionths of a CSS
  // pixel at an overflow edge. Match the classifier's material-geometry floor
  // so numerical noise is not reported as clipped content.
  const geometryEpsilon = 0.5;
  const boundedAttribute = (value) => value && value.length <= 120 ? value : "";
  const selectorFor = (node) => {
    if (node.id) return `#${CSS.escape(node.id)}`;
    const testId = boundedAttribute(node.getAttribute("data-testid"));
    if (testId) return `[data-testid="${CSS.escape(testId)}"]`;
    const role = node.getAttribute("role");
    const ariaLabel = boundedAttribute(node.getAttribute("aria-label"));
    const name = boundedAttribute(node.getAttribute("name"));
    if (role && ariaLabel) return `[role="${CSS.escape(role)}"][aria-label="${CSS.escape(ariaLabel)}"]`;
    if (name) return `[name="${CSS.escape(name)}"]`;
    const parts = [];
    let current = node;
    while (current && current.nodeType === 1 && parts.length < 4) {
      let part = current.tagName.toLowerCase();
      if (current.classList.length) part += `.${CSS.escape(current.classList[0])}`;
      parts.unshift(part);
      current = current.parentElement;
    }
    return parts.join(" > ");
  };
  const hasHiddenAncestor = (node) => {
    let current = node;
    while (current && current.nodeType === 1) {
      const style = window.getComputedStyle(current);
      if (current.hidden || current.inert || current.hasAttribute("inert") || current.getAttribute("aria-hidden") === "true"
        || style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return true;
      // Closed details content can retain layout boxes in Chromium even though
      // it is not painted. Only its first direct summary remains visible.
      if (current.tagName === "DETAILS" && !current.open && current !== node) {
        const summary = [...current.children].find(child => child.tagName === "SUMMARY");
        if (!summary?.contains(node)) return true;
      }
      current = current.parentElement;
    }
    return false;
  };
  const hasEmptyTextClip = (node) => {
    // Screen-reader text still has layout rectangles. Only discard its paint
    // when computed CSS proves the clipping area empty, including a clip on
    // the text itself. Keep unknown shapes and partial clips measurable.
    for (let current = node; current; current = current.parentElement) {
      const style = window.getComputedStyle(current);
      const legacy = style.clip.match(/^rect\(([^)]+)\)$/);
      if (legacy && ["absolute", "fixed"].includes(style.position)) {
        const edges = legacy[1].split(/[,\s]+/).filter(Boolean);
        const lengths = edges.map((edge) => /^-?(?:\d*\.)?\d+px$/.test(edge) ? Number.parseFloat(edge) : null);
        if (lengths.length === 4) {
          const [top, right, bottom, left] = lengths;
          if ((top !== null && bottom !== null && bottom <= top)
            || (left !== null && right !== null && right <= left)) return true;
        }
      }
      const inset = style.clipPath.match(/^inset\(([^)]+)\)(?: border-box)?$/);
      if (!inset) continue;
      const edges = inset[1].split(/\s+round\s+/)[0].trim().split(/\s+/);
      if (edges.length < 1 || edges.length > 4) continue;
      const lengths = edges.map((edge) => {
        const value = edge.match(/^(-?(?:\d*\.)?\d+)(px|%)$/);
        return value ? { value: Number(value[1]), unit: value[2] } : null;
      });
      if (lengths.some((length) => !length)) continue;
      const [top, right = top, bottom = top, left = right] = lengths;
      // A percentage pair that consumes its entire reference dimension is
      // empty even through transforms. Do not infer emptiness from rounded
      // DOM sizes or unsupported calc()/shape/reference-box expressions.
      const consumesDimension = (first, second) => {
        const pair = [first, second];
        return pair.every((length) => length.value >= 0)
          && pair.reduce((sum, length) => sum + (length.unit === "%" ? length.value : 0), 0) >= 100;
      };
      if (consumesDimension(top, bottom) || consumesDimension(left, right)) return true;
    }
    return false;
  };
  const paintedRectFor = (node, rect) => {
    let left = rect.left;
    let top = rect.top;
    let right = rect.right;
    let bottom = rect.bottom;
    let ancestor = node.parentElement;
    while (ancestor && ancestor !== document.body) {
      const style = window.getComputedStyle(ancestor);
      const axisOverflow = (value) => value === "visible" && style.overflow && style.overflow !== "visible"
        ? style.overflow
        : value || style.overflow;
      const clipRect = ancestor.getBoundingClientRect();
      if (["hidden", "clip", "scroll", "auto"].includes(axisOverflow(style.overflowX))) {
        left = Math.max(left, clipRect.left);
        right = Math.min(right, clipRect.right);
      }
      if (["hidden", "clip", "scroll", "auto"].includes(axisOverflow(style.overflowY))) {
        top = Math.max(top, clipRect.top);
        bottom = Math.min(bottom, clipRect.bottom);
      }
      if (right - left <= geometryEpsilon || bottom - top <= geometryEpsilon) return null;
      ancestor = ancestor.parentElement;
    }
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  };
  const measuredElements = Array.from(document.querySelectorAll("body *")).flatMap((node) => {
    const style = window.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0"
      || hasHiddenAncestor(node)) return [];
    const rect = node.getBoundingClientRect();
    if (!rect.width || !rect.height) return [];
    const tag = node.tagName.toLowerCase();
    const role = node.getAttribute("role");
    const interactive = /^(a|button|input|select|textarea|summary)$/.test(tag)
      || ["button", "link", "checkbox", "radio", "tab", "switch"].includes(role);
    const decorative = node.getAttribute("aria-hidden") === "true"
      || ["svg", "path"].includes(tag) && !node.textContent.trim();
    const kind = decorative ? "decorative" : interactive ? "interactive" : role === "presentation" ? "container" : node.children.length ? "container" : "text";
    const domAncestors = [];
    let overlayAncestor = "";
    let ancestor = node.parentElement;
    while (ancestor && ancestor !== document.body) {
      domAncestors.push(selectorFor(ancestor));
      if (!overlayAncestor && ["absolute", "fixed", "sticky"].includes(window.getComputedStyle(ancestor).position)) {
        overlayAncestor = selectorFor(ancestor);
      }
      ancestor = ancestor.parentElement;
    }
    const copiedRect = {
      left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height,
    };
    return [{ node, element: { id: node.id || selectorFor(node), kind, selector: selectorFor(node), rect: copiedRect,
      paintedRect: kind === "text" && hasEmptyTextClip(node) ? null : paintedRectFor(node, copiedRect),
      domAncestors, overlayAncestor: overlayAncestor || null,
      fixed: style.position === "fixed", positioning: style.position, text: node.textContent.trim().slice(0, 120) } }];
  });
  const elements = measuredElements.map((entry) => entry.element);
  const visibleDialogs = Array.from(document.querySelectorAll('[role="dialog"], dialog')).filter((node) => !hasHiddenAncestor(node));
  const dialogs = visibleDialogs.map((node) => ({ selector: selectorFor(node), rect: (() => { const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; })() }));
  // Clipping is measured from the live node each entry was built from. Looking
  // the element up again by its selector re-resolved a repeated control — a
  // board card, a list row — to the FIRST match in the document and then walked
  // THAT node's ancestors, so a card in the second column was compared with the
  // first column's rectangle and reported as clipped by a box it never sat in.
  // Historical board GEOMETRY evidence does not identify its failing
  // sub-rule, so this correction does not establish that campaign's cause.
  const clipped = measuredElements.filter((entry) => entry.element.kind === "interactive").flatMap(({ node, element }) => {
    let ancestor = node.parentElement;
    let reachableX = false;
    let reachableY = false;
    while (ancestor && ancestor !== document.body) {
      const style = window.getComputedStyle(ancestor);
      const axisOverflow = (value) => value === "visible" && style.overflow && style.overflow !== "visible"
        ? style.overflow
        : value || style.overflow;
      const overflowX = axisOverflow(style.overflowX);
      const overflowY = axisOverflow(style.overflowY);
      const clipsX = ["hidden", "clip", "scroll", "auto"].includes(overflowX);
      const clipsY = ["hidden", "clip", "scroll", "auto"].includes(overflowY);
      if (clipsX || clipsY) {
        const clipRect = ancestor.getBoundingClientRect();
        const outsideX = element.rect.left < clipRect.left - geometryEpsilon
          || element.rect.right > clipRect.right + geometryEpsilon;
        const outsideY = element.rect.top < clipRect.top - geometryEpsilon
          || element.rect.bottom > clipRect.bottom + geometryEpsilon;
        const scrollableX = ["scroll", "auto"].includes(overflowX)
          && ancestor.scrollWidth > ancestor.clientWidth + geometryEpsilon;
        const scrollableY = ["scroll", "auto"].includes(overflowY)
          && ancestor.scrollHeight > ancestor.clientHeight + geometryEpsilon;
        const unreachableX = clipsX && outsideX && !scrollableX && !reachableX;
        const unreachableY = clipsY && outsideY && !scrollableY && !reachableY;
        if (unreachableX || unreachableY) return [{ selector: element.selector, rect: element.rect, clipper: selectorFor(ancestor), clipRect: {
          left: clipRect.left, top: clipRect.top, right: clipRect.right, bottom: clipRect.bottom,
          width: clipRect.width, height: clipRect.height,
        } }];
        if (outsideX && scrollableX) reachableX = true;
        if (outsideY && scrollableY) reachableY = true;
      }
      ancestor = ancestor.parentElement;
    }
    return [];
  });
  const brokenImages = Array.from(document.images).filter((image) => !hasHiddenAncestor(image) && image.complete && image.naturalWidth === 0).map((image) => {
    const rect = image.getBoundingClientRect();
    return { selector: selectorFor(image), rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height } };
  });
  const active = document.activeElement;
  return { route: document.body.dataset.auditRoute || window.location.pathname, viewport, document: { scrollWidth: root.scrollWidth }, elements, clipped, brokenImages, dialogs, fixedObstructions: elements.filter((element) => ["fixed", "sticky"].includes(element.positioning)), focus: active && active !== document.body ? { selector: selectorFor(active), hidden: !active.getClientRects().length } : null };
}

export function renderVisualAuditMarkdown(report) {
  const route = report.route || report.failures?.[0]?.route || report.warnings?.[0]?.route || "unknown route";
  const lines = [`# Visual audit: ${route}`, "", `Inspected: ${report.inspected ?? 0}`, ""];
  for (const [label, findings] of [["Definite failures", report.failures || []], ["Warnings", report.warnings || []]]) {
    lines.push(`## ${label}`, "");
    lines.push(...(findings.length ? findings.flatMap((item) => {
      const selectors = (item.selectors || [item.selector]).filter(Boolean).join(", ");
      const explanation = String(item.explanation || item.message || "").slice(0, 120);
      const severity = item.severity || (label === "Warnings" ? "warning" : "failure");
      const viewport = item.viewport || report.viewport;
      const geometry = JSON.stringify(item.rectangles || []);
      const intersection = item.intersectionRect ? `\n  - intersection rectangle: \`${JSON.stringify(item.intersectionRect)}\`` : "";
      return [
        `- **${item.rule}** (${severity}) — ${selectors}: ${explanation}`,
        `  - route: ${item.route || route}; viewport: ${viewport ? `${viewport.width}×${viewport.height}` : "unknown"}`,
        `  - rectangles: \`${geometry}\`${intersection}`,
      ];
    }) : ["- None"]), "");
  }
  return lines.join("\n");
}
