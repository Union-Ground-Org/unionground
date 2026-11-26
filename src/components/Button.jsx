import { forwardRef } from "react";
import { BusyButton } from "./BusyControls.jsx";
import { useLang } from "../lib/LanguageContext.jsx";
import "./button.css";

/** Shared action. `as="a"` accepts href; a busy link stays in place. */
export const Button = forwardRef(function Button({ as: Element = "button", variant = "primary", size = "default", icon, loading = false, pending = false, disabled = false, disabledReason, onBlockedPress, children, className = "", onClick, type = "button", ...props }, ref) {
  const { t } = useLang();
  const unavailable = disabled || loading || pending;
  const isButton = Element === "button";
  const Control = isButton ? BusyButton : Element;
  return <Control
    {...props}
    ref={ref}
    {...(isButton ? { type, disabled, disabledReason, onBlockedPress, pending: loading || pending } : { "aria-disabled": unavailable || undefined, tabIndex: disabled ? -1 : props.tabIndex })}
    className={`sg-button sg-button--${variant} sg-button--${size} ${className}`.trim()}
    aria-busy={loading || pending || props["aria-busy"] || undefined}
    aria-label={props["aria-label"] || (loading ? t("button.loadingAction", { action: typeof children === "string" ? children : t("button.action") }) : undefined)}
    onClick={(event) => { if (unavailable) { event.preventDefault(); return undefined; } return onClick?.(event); }}
  >
    {loading ? <span className="sg-button__spinner" aria-hidden="true" /> : icon && <span className="sg-button__icon" aria-hidden="true">{icon}</span>}
    <span>{children}</span>
  </Control>;
});
