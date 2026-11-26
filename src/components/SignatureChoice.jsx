import { useId, useState } from "react";
import { SignaturePad } from "./SignaturePad.jsx";
import { BusyFieldset, BusyInput } from "./BusyControls.jsx";
import { TYPED_SIGNATURE_MAX, typedSignatureProblem } from "../lib/typedSignature.js";

export const EMPTY_SIGNATURE = Object.freeze({ kind: "drawn", strokes: [], name: "" });

// The way a member signs (#8701): draw on the pad, or type their full name.
// Drawing stays the default and works exactly as before; both ways keep
// their own input while the member switches, and the caller's consent box
// and Save button apply to whichever way is chosen.
// pending (#8435): the host's write is running; the choice stays focusable and
// refuses changes until it settles. disabled: the host refuses it outright.
export function SignatureChoice({ value = EMPTY_SIGNATURE, onChange, disabled = false, pending = false, labels, padProps }) {
  const [touched, setTouched] = useState(false);
  const nameId = useId();
  const hintId = useId();
  const errorId = useId();
  const groupName = useId();
  const kind = value.kind === "typed" ? "typed" : "drawn";
  const problem = typedSignatureProblem(value.name);
  const showProblem = kind === "typed" && problem !== "" && (touched || String(value.name || "").trim() !== "");
  const update = (patch) => onChange({ ...EMPTY_SIGNATURE, ...value, ...patch });

  return (
    <div className="form-signature-choice">
      <BusyFieldset className="form-signature-choice__ways" pending={pending} disabled={disabled}>
        <legend>{labels.legend}</legend>
        <label className="form-signature-choice__way">
          <input type="radio" name={groupName} value="drawn" checked={kind === "drawn"} onChange={() => update({ kind: "drawn" })} />
          <span>{labels.draw}</span>
        </label>
        <label className="form-signature-choice__way">
          <input type="radio" name={groupName} value="typed" checked={kind === "typed"} onChange={() => update({ kind: "typed" })} />
          <span>{labels.type}</span>
        </label>
      </BusyFieldset>
      {kind === "drawn" ? (
        <SignaturePad
          {...padProps}
          value={value.strokes || []}
          onChange={(strokes) => update({ strokes })}
          disabled={disabled}
          pending={pending}
        />
      ) : (
        <div className="form-signature form-signature--typed">
          <label htmlFor={nameId}><strong>{labels.nameLabel}</strong></label>
          <p id={hintId} className="form-filing__hint">{labels.nameHint}</p>
          <BusyInput
            id={nameId}
            className="form-signature__typed-name"
            type="text"
            autoComplete="name"
            spellCheck={false}
            maxLength={TYPED_SIGNATURE_MAX * 2}
            value={value.name || ""}
            pending={pending}
            disabled={disabled}
            aria-describedby={showProblem ? `${hintId} ${errorId}` : hintId}
            aria-invalid={showProblem || undefined}
            onChange={(event) => update({ name: event.target.value })}
            onBlur={() => setTouched(true)}
          />
          {showProblem && <p id={errorId} className="form-filing__warning">{labels.problems[problem]}</p>}
        </div>
      )}
    </div>
  );
}
