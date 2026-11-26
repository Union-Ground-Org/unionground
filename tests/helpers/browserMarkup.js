// Keep inline minimum dimensions when moving a jsdom fixture into Chromium.
// jsdom 31 serializes min-width/height together as min-size, a shorthand the
// browser does not support yet. Expand it without changing the rendered app.
export function browserMarkup(container) {
  const copy = container.cloneNode(true);
  for (const node of copy.querySelectorAll("[style]")) {
    if (!node.style.getPropertyValue("min-size")) continue;
    const { minWidth, minHeight } = node.style;
    const priority = node.style.getPropertyPriority("min-size") ? " !important" : "";
    const rest = node.getAttribute("style").replace(/(^|;)\s*min-size\s*:[^;]*/g, "$1");
    // Raw attributes retain the longhands; assigning cssText combines them again.
    node.setAttribute("style", `${rest}; min-width: ${minWidth}${priority}; min-height: ${minHeight}${priority};`);
  }
  return copy.innerHTML;
}
