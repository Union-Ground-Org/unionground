import { useEffect, useId, useRef, useState } from "react";
import { BusyButton } from "./BusyControls.jsx";

const LIMIT = 1000;
const KEY_STEP = 25;
export const MAX_STROKES = 64;
const MAX_POINTS_PER_STROKE = 512;
const MAX_POINTS = 2000;
const PEN_RADIUS = 4;

function clamp(value) {
  return Math.max(0, Math.min(LIMIT, Math.round(value)));
}

function pointFromEvent(canvas, event) {
  const rect = canvas.getBoundingClientRect();
  const width = rect.width || 1;
  const height = rect.height || 1;
  return {
    x: clamp(((event.clientX - rect.left) / width) * LIMIT),
    y: clamp(((event.clientY - rect.top) / height) * LIMIT),
  };
}

function paint(canvas, strokes, pen, showPen) {
  let context;
  try { context = canvas.getContext("2d"); } catch { return; }
  if (!context) return;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  const density = Math.max(1, globalThis.devicePixelRatio || 1);
  if (canvas.width !== Math.round(width * density) || canvas.height !== Math.round(height * density)) {
    canvas.width = Math.round(width * density);
    canvas.height = Math.round(height * density);
  }
  context.setTransform(density, 0, 0, density, 0, 0);
  context.clearRect(0, 0, width, height);
  const tokens = getComputedStyle(canvas);
  const ink = tokens.getPropertyValue("--green").trim() || "currentColor";
  context.strokeStyle = ink;
  context.lineWidth = 2.25;
  context.lineCap = "round";
  context.lineJoin = "round";
  for (const stroke of strokes || []) {
    if (!Array.isArray(stroke) || stroke.length === 0) continue;
    context.beginPath();
    stroke.forEach((point, index) => {
      const x = (clamp(point.x) / LIMIT) * width;
      const y = (clamp(point.y) / LIMIT) * height;
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    if (stroke.length === 1) context.lineTo(((clamp(stroke[0].x) + 1) / LIMIT) * width, (clamp(stroke[0].y) / LIMIT) * height);
    context.stroke();
  }
  if (showPen && pen) {
    const x = (clamp(pen.x) / LIMIT) * width;
    const y = (clamp(pen.y) / LIMIT) * height;
    context.beginPath();
    context.arc(x, y, PEN_RADIUS, 0, Math.PI * 2);
    context.fillStyle = ink;
    context.fill();
  }
}

export function SignaturePad({
  value = [], onChange, disabled = false, pending = false, label, instructions, clearLabel,
  emptyStatus, strokeStatus, capStatus, statusRole = "status",
}) {
  // pending (#8435): the host's write is running. The pad keeps its place in
  // the tab order and refuses drawing and Clear until it settles.
  const blocked = disabled || pending;
  const canvasRef = useRef(null);
  const strokesRef = useRef(value);
  const pointerDrawing = useRef(false);
  const keyboardDrawing = useRef(false);
  const penRef = useRef({ x: 500, y: 500 });
  const focusedRef = useRef(false);
  const [pen, setPen] = useState({ x: 500, y: 500 });
  const [focused, setFocused] = useState(false);
  const [capReached, setCapReached] = useState(false);
  const instructionsId = useId();

  function movePen(point) {
    penRef.current = point;
    setPen(point);
  }

  useEffect(() => {
    strokesRef.current = value;
    focusedRef.current = focused;
    penRef.current = pen;
    const canvas = canvasRef.current;
    if (canvas) paint(canvas, value, focused ? pen : null, focused);
  }, [value, focused, pen]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver !== "function") return undefined;
    const observer = new ResizeObserver(() => paint(
      canvas,
      strokesRef.current,
      focusedRef.current ? penRef.current : null,
      focusedRef.current,
    ));
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  function emit(next) {
    strokesRef.current = next;
    onChange(next);
  }

  function begin(point) {
    const current = strokesRef.current || [];
    const points = current.reduce((total, stroke) => total + (Array.isArray(stroke) ? stroke.length : 0), 0);
    if (current.length >= MAX_STROKES || points >= MAX_POINTS) {
      setCapReached(true);
      return false;
    }
    movePen(point);
    emit([...current, [point]]);
    return true;
  }

  function append(point) {
    const current = strokesRef.current || [];
    const active = current[current.length - 1];
    const points = current.reduce((total, stroke) => total + (Array.isArray(stroke) ? stroke.length : 0), 0);
    if (!Array.isArray(active) || active.length >= MAX_POINTS_PER_STROKE || points >= MAX_POINTS) {
      setCapReached(true);
      return false;
    }
    movePen(point);
    const next = current.map((stroke, index, rows) =>
      index === rows.length - 1 ? [...stroke, point] : stroke);
    emit(next);
    return true;
  }

  function finish() {
    const current = strokesRef.current || [];
    const active = current[current.length - 1];
    if (Array.isArray(active) && active.length === 1) {
      const point = active[0];
      append({ x: point.x < LIMIT ? point.x + 1 : point.x - 1, y: point.y });
    }
  }

  function endKeyboardStroke() {
    if (!keyboardDrawing.current) return;
    finish();
    keyboardDrawing.current = false;
  }

  function onPointerDown(event) {
    if (blocked) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    pointerDrawing.current = begin(pointFromEvent(event.currentTarget, event));
  }

  function onPointerMove(event) {
    if (blocked || !pointerDrawing.current) return;
    append(pointFromEvent(event.currentTarget, event));
  }

  function onKeyDown(event) {
    if (blocked) return;
    if (event.key === " " || event.key === "Spacebar") {
      event.preventDefault();
      if (keyboardDrawing.current) endKeyboardStroke();
      else keyboardDrawing.current = begin(penRef.current);
      return;
    }
    const delta = {
      ArrowLeft: [-KEY_STEP, 0], ArrowRight: [KEY_STEP, 0],
      ArrowUp: [0, -KEY_STEP], ArrowDown: [0, KEY_STEP],
    }[event.key];
    if (!delta) return;
    event.preventDefault();
    const next = { x: clamp(penRef.current.x + delta[0]), y: clamp(penRef.current.y + delta[1]) };
    movePen(next);
    if (keyboardDrawing.current) append(next);
  }

  const strokeCount = value.filter((stroke) => Array.isArray(stroke) && stroke.length > 0).length;
  const statusText = capReached && capStatus
    ? capStatus
    : strokeCount === 0
      ? emptyStatus
      : (strokeStatus?.(strokeCount) || "");
  const clear = () => {
    pointerDrawing.current = false;
    keyboardDrawing.current = false;
    movePen({ x: 500, y: 500 });
    setCapReached(false);
    emit([]);
  };
  return (
    <div className="form-signature">
      <div className="form-signature__head">
        <strong>{label}</strong>
        <BusyButton type="button" className="form-filing__quiet" pending={pending} disabled={disabled || strokeCount === 0} onClick={clear}>
          {clearLabel}
        </BusyButton>
      </div>
      <p id={instructionsId} className="form-filing__hint">{instructions}</p>
      <canvas
        ref={canvasRef}
        className="form-signature__canvas"
        aria-label={label}
        aria-describedby={instructionsId}
        aria-disabled={blocked || undefined}
        aria-busy={pending || undefined}
        tabIndex={disabled ? -1 : 0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => { if (pointerDrawing.current) finish(); pointerDrawing.current = false; }}
        onPointerCancel={() => { pointerDrawing.current = false; }}
        onLostPointerCapture={() => { if (pointerDrawing.current) finish(); pointerDrawing.current = false; }}
        onFocus={() => { if (!disabled) setFocused(true); }}
        onBlur={() => { setFocused(false); endKeyboardStroke(); }}
        onKeyDown={onKeyDown}
      />
      <span className="sr-only" role={statusRole} aria-live="polite">
        {statusText}
      </span>
      {/* #9467 W3b-10: a full pad says so on screen, not only to a screen
          reader. The live region above already announces the same words. */}
      {capReached && capStatus ? <p className="form-filing__warning" aria-hidden="true">{capStatus}</p> : null}
    </div>
  );
}
