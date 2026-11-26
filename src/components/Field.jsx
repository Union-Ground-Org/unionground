import { cloneElement, isValidElement, useId } from "react";
import "./field.css";

/** Supports civic's render-child contract and ordinary form controls. */
export function Field({ label, hint, error, children, className = "" }) {
  const generatedId = useId();
  const id = isValidElement(children) && children.props.id ? children.props.id : generatedId;
  const described = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(" ") || undefined;
  const inputProps = { id, "aria-describedby": described, "aria-invalid": error ? true : undefined };
  return <div className={`civic-field sg-field${error ? " civic-field-invalid sg-field--invalid" : ""} ${className}`.trim()}>
    <label htmlFor={id}>{label}</label>
    {hint && <p id={`${id}-hint`} className="civic-hint sg-field__hint">{hint}</p>}
    {typeof children === "function" ? children(inputProps) : isValidElement(children) ? cloneElement(children, { ...inputProps, ...children.props, "aria-describedby": [described, children.props["aria-describedby"]].filter(Boolean).join(" ") || undefined }) : children}
    {error && <p id={`${id}-error`} className="civic-error sg-field__error">{error}</p>}
  </div>;
}
