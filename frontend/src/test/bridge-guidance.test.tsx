import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeError, errors } from "../../../shared/src/bridge";
import { BridgeConnection } from "@/routes/settings";
const state = vi.hoisted(() => ({ connect: vi.fn(), dispose: vi.fn() }));
vi.mock("@/services/extension-adapter", () => ({
  BridgeClient: class {
    connect = state.connect;
    dispose = state.dispose;
  },
  detectExtension: async () => false,
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
describe("Settings bridge connection guidance", () => {
  it.each([
    "MISSING_EXTENSION",
    "TIMEOUT",
    "PERMISSION_DENIED",
    "RECONNECT_REQUIRED",
    "BACKEND_UNAVAILABLE",
  ] as const)("shows actionable %s and keeps HTTP availability explained", async (code) => {
    state.connect.mockRejectedValue(new BridgeError(code));
    render(<BridgeConnection />);
    fireEvent.click(screen.getByRole("button", { name: "Check / reconnect extension" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(errors[code]));
    expect(screen.getAllByText(/write may have completed/).length).toBeGreaterThan(0);
    expect(state.dispose).toHaveBeenCalledOnce();
  });
  it("hello explicitly reports local repository only and never claims Moodle collection", async () => {
    state.connect.mockResolvedValue({
      backend: "ready",
      localRepository: "ready",
      moodleCollection: "unavailable",
    });
    render(<BridgeConnection />);
    fireEvent.click(screen.getByRole("button", { name: "Check / reconnect extension" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Moodle collection is unavailable"),
    );
    expect(screen.getByRole("status")).toHaveTextContent("continues using the local HTTP backend");
  });
});
