import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("sonner", () => ({
  Toaster: ({ theme }: { theme: string }) => <div data-testid="toast-theme">{theme}</div>,
}));
import { Toaster } from "@/components/ui/sonner";
afterEach(() => {
  cleanup();
  document.documentElement.classList.remove("dark");
});
it("keeps notifications aligned with the chosen document theme", async () => {
  document.documentElement.classList.add("dark");
  render(<Toaster />);
  await waitFor(() => expect(screen.getByTestId("toast-theme")).toHaveTextContent("dark"));
  document.documentElement.classList.remove("dark");
  await waitFor(() => expect(screen.getByTestId("toast-theme")).toHaveTextContent("light"));
});
