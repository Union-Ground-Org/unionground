import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { useDesk } from "../src/lib/useDesk.js";
import { SHELL_LOAD_DEADLINE_MS } from "../src/lib/loadDeadline.js";

afterEach(cleanup);

function controlledApi() {
  const pending = [];
  return {
    pending,
    loadDesk() {
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    },
  };
}

describe("staff desk reload ordering", () => {
  it.each(["success", "failure"])("ignores an older %s after a newer reload succeeds", async (outcome) => {
    const api = controlledApi();
    const { result } = renderHook(() => useDesk(api));
    await act(async () => api.pending[0].resolve({ chapter: "Initial" }));

    let older, newer;
    act(() => { older = result.current.load(); newer = result.current.load(); });
    await act(async () => { api.pending[2].resolve({ chapter: "Newly saved" }); await newer; });
    await act(async () => {
      if (outcome === "success") api.pending[1].resolve({ chapter: "Stale" });
      else api.pending[1].reject(new Error("Stale failure"));
      await older;
    });

    expect(result.current.desk).toEqual({ chapter: "Newly saved" });
    expect(result.current.error).toBe("");
  });

  it("keeps the newest failure when an older reload succeeds afterward", async () => {
    const api = controlledApi();
    const { result } = renderHook(() => useDesk(api));
    await act(async () => api.pending[0].resolve({ chapter: "Initial" }));

    let older, newer;
    act(() => { older = result.current.load(); newer = result.current.load(); });
    await act(async () => { api.pending[2].reject(new Error("Current failure")); await newer; });
    await act(async () => { api.pending[1].resolve({ chapter: "Stale" }); await older; });

    expect(result.current.error).toBe("Load failed");
    expect(result.current.desk).toEqual({ chapter: "Initial" });
  });

  it("keeps localized errors and clears them for a successful retry", async () => {
    const api = controlledApi();
    const wrapper = ({ children }) => <LanguageProvider lang="es">{children}</LanguageProvider>;
    const { result } = renderHook(() => useDesk(api), { wrapper });
    await act(async () => api.pending[0].reject(new Error()));
    expect(result.current.error).toBe("Error al cargar");

    let retry;
    act(() => { retry = result.current.load(); });
    expect(result.current.error).toBe("");
    await act(async () => { api.pending[1].resolve({ chapter: "Recovered" }); await retry; });
    expect(result.current.desk).toEqual({ chapter: "Recovered" });
    expect(result.current.error).toBe("");
  });

  it("BUG-UG-STAFF-DESK-STALE-RELOAD-20260907 clears an existing failure card only for the newest successful retry", async () => {
    const api = controlledApi();
    const { result } = renderHook(() => useDesk(api));
    await act(async () => api.pending[0].reject(new Error("Initial failure")));
    expect(result.current.error).toBe("Load failed");

    let olderRetry, newestRetry;
    act(() => {
      olderRetry = result.current.load();
      newestRetry = result.current.load();
    });
    await act(async () => {
      api.pending[2].resolve({ chapter: "Recovered" });
      await newestRetry;
    });
    await act(async () => {
      api.pending[1].reject(new Error("Stale retry failure"));
      await olderRetry;
    });

    expect(result.current.desk).toEqual({ chapter: "Recovered" });
    expect(result.current.error).toBe("");
  });

  it("stores the translated fallback instead of a driver message", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const api = controlledApi();
    const { result } = renderHook(() => useDesk(api));
    await act(async () => api.pending[0].reject(new Error("Case queue: TypeError: Failed to fetch")));
    expect(result.current.error).toBe("Load failed");
    expect(result.current.desk).toBeNull();
    expect(logged).not.toHaveBeenCalled();
    logged.mockRestore();
  });

  it("rejects a never-resolving loadDesk after the shared deadline without a second in-flight read winning", async () => {
    vi.useFakeTimers();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const api = { loadDesk: vi.fn(() => new Promise(() => {})) };
    const { result } = renderHook(() => useDesk(api, "app.loadFailed", null, SHELL_LOAD_DEADLINE_MS));
    expect(api.loadDesk).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(SHELL_LOAD_DEADLINE_MS); });
    expect(result.current.error).toBe("Load failed");
    expect(result.current.desk).toBeNull();
    expect(logged).not.toHaveBeenCalled();
    let retry;
    act(() => { retry = result.current.load(); });
    expect(result.current.error).toBe("");
    expect(api.loadDesk).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(SHELL_LOAD_DEADLINE_MS); await retry; });
    expect(result.current.error).toBe("Load failed");
    expect(api.loadDesk).toHaveBeenCalledTimes(2);
    expect(logged).not.toHaveBeenCalled();
    logged.mockRestore();
    vi.useRealTimers();
  });

  it("BUG-UG-STAFF-DESK-FAILED-LOAD-STICKS-ACROSS-PAGES-20261106 reads a failed desk again when another page opens", async () => {
    const api = controlledApi();
    const { result, rerender } = renderHook(({ page }) => useDesk(api, "app.loadFailed", page), { initialProps: { page: "admin-job-health" } });
    await act(async () => api.pending[0].reject(new Error("statement timeout")));
    expect(result.current.error).toBe("Load failed");

    rerender({ page: "admin-job-health" });
    expect(api.pending).toHaveLength(1);

    rerender({ page: "admin-labels" });
    expect(api.pending).toHaveLength(2);
    expect(result.current.error).toBe("");
    await act(async () => api.pending[1].resolve({ chapter: "Recovered" }));
    expect(result.current.desk).toEqual({ chapter: "Recovered" });
    expect(result.current.error).toBe("");
  });

  it("does not read a loaded desk again just because another page opens", async () => {
    const api = controlledApi();
    const { result, rerender } = renderHook(({ page }) => useDesk(api, "app.loadFailed", page), { initialProps: { page: "overview" } });
    await act(async () => api.pending[0].resolve({ chapter: "Loaded" }));
    rerender({ page: "vp-trend" });
    rerender({ page: "vp-attention" });
    expect(api.pending).toHaveLength(1);
    expect(result.current.desk).toEqual({ chapter: "Loaded" });
  });

  it("patches only a desk that is already shown", async () => {
    const api = controlledApi();
    const { result } = renderHook(() => useDesk(api));
    act(() => result.current.patch((desk) => ({ ...desk, chapter: "Too early" })));
    expect(result.current.desk).toBeNull();
    await act(async () => api.pending[0].resolve({ chapter: "Loaded" }));
    act(() => result.current.patch((desk) => ({ ...desk, chapter: "Saved" })));
    expect(result.current.desk).toEqual({ chapter: "Saved" });
  });

  it("ignores the previous API's pending result after the API changes", async () => {
    const previousApi = controlledApi();
    const currentApi = controlledApi();
    const { result, rerender } = renderHook(({ api }) => useDesk(api), { initialProps: { api: previousApi } });
    rerender({ api: currentApi });
    await act(async () => currentApi.pending[0].resolve({ chapter: "Current" }));
    await act(async () => previousApi.pending[0].resolve({ chapter: "Previous" }));
    expect(result.current.desk).toEqual({ chapter: "Current" });
    expect(result.current.error).toBe("");
  });
});
