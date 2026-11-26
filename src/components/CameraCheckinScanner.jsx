import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useLang } from "../lib/LanguageContext.jsx";
import { CHECKIN_TOKEN_ALPHABET } from "../lib/checkinQr.js";
import { BusyButton } from "./BusyControls.jsx";

const TOKEN_PATTERN = new RegExp(`^[${CHECKIN_TOKEN_ALPHABET}]{7}$`);
const REFUSED_ERRORS = new Set(["NotAllowedError", "SecurityError"]);
const NO_CAMERA_ERRORS = new Set(["NotFoundError", "NotReadableError", "OverconstrainedError"]);

function startFailureKey(error) {
  const name = error?.name;
  if (REFUSED_ERRORS.has(name)) return "steward.scanCameraDenied";
  if (NO_CAMERA_ERRORS.has(name)) return "steward.scanCameraNoCamera";
  return "steward.scanCameraFailed";
}

// pending (record 8435): the host's check-in write is running. Start camera
// stays focusable and refuses activation until it settles, as it does while
// the camera itself is starting. disabled: the host refuses it outright.
export const CameraCheckinScanner = forwardRef(function CameraCheckinScanner({ disabled = false, pending = false, onCode }, ref) {
  const { t } = useLang();
  const [supported, setSupported] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [errorKey, setErrorKey] = useState("");
  const [wrongCode, setWrongCode] = useState(false);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const frameRef = useRef(null);
  const detectorRef = useRef(null);
  const handledRef = useRef(false);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);

  const stop = useCallback(() => {
    generationRef.current += 1;
    if (frameRef.current != null) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    for (const track of streamRef.current?.getTracks?.() || []) track.stop();
    streamRef.current = null;
    detectorRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    if (mountedRef.current) {
      setScanning(false);
      setStarting(false);
      setWrongCode(false);
    }
  }, []);

  useImperativeHandle(ref, () => ({ stop }), [stop]);

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    async function detectSupport() {
      if (!navigator.mediaDevices?.getUserMedia || typeof globalThis.BarcodeDetector !== "function") {
        if (!cancelled) setSupported(false);
        return;
      }
      try {
        const formats = typeof globalThis.BarcodeDetector.getSupportedFormats === "function"
          ? await globalThis.BarcodeDetector.getSupportedFormats()
          : ["qr_code"];
        if (!cancelled) setSupported(formats.includes("qr_code"));
      } catch {
        if (!cancelled) setSupported(false);
      }
    }
    void detectSupport();
    return () => {
      cancelled = true;
      mountedRef.current = false;
      generationRef.current += 1;
      if (frameRef.current != null) window.cancelAnimationFrame(frameRef.current);
      for (const track of streamRef.current?.getTracks?.() || []) track.stop();
      streamRef.current = null;
      detectorRef.current = null;
    };
  }, []);

  const scanFrame = useCallback(async (generation) => {
    if (generation !== generationRef.current || !mountedRef.current
      || !streamRef.current || handledRef.current || !detectorRef.current || !videoRef.current) return;
    const stream = streamRef.current;
    const detector = detectorRef.current;
    const video = videoRef.current;
    try {
      const codes = await detector.detect(video);
      if (generation !== generationRef.current || !mountedRef.current || streamRef.current !== stream) return;
      const token = String(codes?.[0]?.rawValue || "").trim().toUpperCase();
      if (TOKEN_PATTERN.test(token)) {
        handledRef.current = true;
        stop();
        await onCode(token);
        return;
      }
      if (token) setWrongCode(true);
    } catch {
      // A single undecodable frame is normal while the phone is moving. Keep
      // the stream local and try the next frame; permission failures are
      // handled during camera startup below.
    }
    if (generation === generationRef.current && mountedRef.current
      && streamRef.current === stream && !handledRef.current) {
      frameRef.current = window.requestAnimationFrame(() => void scanFrame(generation));
    }
  }, [onCode, stop]);

  const start = useCallback(async () => {
    if (!supported || starting || scanning || disabled || pending) return;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    setStarting(true);
    setErrorKey("");
    handledRef.current = false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" } },
      });
      if (!mountedRef.current || generation !== generationRef.current) {
        for (const track of stream.getTracks?.() || []) track.stop();
        return;
      }
      streamRef.current = stream;
      detectorRef.current = new globalThis.BarcodeDetector({ formats: ["qr_code"] });
      const video = videoRef.current;
      if (!video) {
        stop();
        return;
      }
      video.srcObject = stream;
      await video.play();
      if (!mountedRef.current || generation !== generationRef.current || streamRef.current !== stream) {
        if (streamRef.current === stream) stop();
        return;
      }
      setStarting(false);
      setScanning(true);
      void scanFrame(generation);
    } catch (error) {
      if (!mountedRef.current || generation !== generationRef.current) return;
      stop();
      if (mountedRef.current) setErrorKey(startFailureKey(error));
    }
  }, [disabled, pending, scanFrame, scanning, starting, stop, supported]);

  if (supported === false) {
    return <p className="cwk-form__help" role="status">{t("steward.scanCameraUnsupported")}</p>;
  }

  return (
    <div className="cwk-camera">
      <video
        ref={videoRef}
        className={scanning ? "cwk-camera__preview" : "cwk-camera__preview cwk-camera__preview--hidden"}
        autoPlay
        muted
        playsInline
        role="img"
        aria-label={t("steward.scanCameraPreview")}
      />
      {scanning && <p className="cwk-form__help" role="status">{t(wrongCode ? "steward.scanCameraWrongCode" : "steward.scanCameraHint")}</p>}
      {errorKey && <p className="cwk-form__help" role="status">{t(errorKey)}</p>}
      {scanning ? (
        <button type="button" className="cwk-btn cwk-btn--soft cwk-btn--wide" onClick={stop}>
          {t("steward.scanCameraStop")}
        </button>
      ) : (
        <BusyButton type="button" className="cwk-btn cwk-btn--soft cwk-btn--wide" pending={pending || starting} disabled={disabled || supported !== true} onClick={start}>
          {t(starting ? "steward.scanCameraStarting" : "steward.scanCamera")}
        </BusyButton>
      )}
    </div>
  );
});
