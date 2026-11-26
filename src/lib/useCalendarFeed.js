import { useEffect, useRef, useState } from "react";
import { runBusyWrite } from "./busyWrite.js";

export function useCalendarFeed(loadStatus, rotate, revoke) {
  const [status, setStatus] = useState("loading");
  const [attempt, setAttempt] = useState(0);
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const busyWriteRef = useRef(new Set());
  const nextActionRef = useRef(null);
  const pendingFocus = useRef(null);

  useEffect(() => {
    if (status === "loading") return;
    const previous = pendingFocus.current;
    pendingFocus.current = null;
    if (previous && !previous.isConnected && document.activeElement === document.body) {
      nextActionRef.current?.focus();
    }
  }, [status]);

  useEffect(() => {
    if (!loadStatus) return undefined;
    let current = true;
    async function read() {
      try {
        const active = await loadStatus();
        if (current) setStatus(active === true ? "active" : active === false ? "inactive" : "error");
      } catch (error) {
        if (current) setStatus(error?.code === "42501" ? "refused" : "error");
      }
    }
    void read();
    return () => { current = false; };
  }, [loadStatus, attempt]);

  function retry(event) {
    const button = event.currentTarget;
    if (document.activeElement === button) pendingFocus.current = button;
    setStatus("loading");
    setAttempt((previous) => previous + 1);
  }

  function mint(onSuccess) {
    return runBusyWrite(busyWriteRef, "calendar-link", async () => {
      setBusy(true);
      try {
        const result = await rotate();
        if (result?.token) {
          // Keep the bearer URL in this mounted control only.
          setLink(`${window.location.origin}/api/calendar?token=${result.token}`);
          setStatus("active");
          onSuccess?.();
        }
      } catch {
        // The parent reports the write failure. Keep the previous state.
      } finally {
        setBusy(false);
      }
    });
  }

  function turnOff(event, onSuccess) {
    const button = event.currentTarget;
    return runBusyWrite(busyWriteRef, "calendar-link", async () => {
      setBusy(true);
      try {
        if ((await revoke())?.revoked === true) {
          if (document.activeElement === button) pendingFocus.current = button;
          setLink("");
          setStatus("inactive");
          onSuccess?.();
        }
      } catch {
        // The existing feed may still be live.
      } finally {
        setBusy(false);
      }
    });
  }

  return { status, link, busy, retrying: attempt > 0 && status === "loading", retry, mint, turnOff, nextActionRef };
}
