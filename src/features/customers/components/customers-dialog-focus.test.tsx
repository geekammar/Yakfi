/**
 * FlowPilot — Customer Dialog Focus Restoration Regression Test
 *
 * Verifies that:
 * 1. CustomersDirectory → CustomerFormDialog composition restores focus to the actual
 *    opening control (primary button and empty-state button) after Escape, close button, and Cancel.
 * 2. Reopening after closure reliably tracks and restores focus to the active opener.
 * 3. Surviving focus target fallback functions if the opener element is disconnected.
 * 4. Smart Create (CustomerStep) preserves CustomerFormDialog focus restoration contract.
 */

import { CustomerStep } from "@/features/appointments/components/smart-create/customer-step";
import { CustomerFormDialog } from "@/features/customers/components/customer-form-dialog";
import { CustomersDirectory } from "@/features/customers/components/customers-directory";
import type { CustomerListItem } from "@/features/customers/types";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/features/customers/actions/customer-actions", () => ({
  searchCustomersAction: vi
    .fn()
    .mockResolvedValue({ success: true, customers: [] }),
  createCustomerAction: vi
    .fn()
    .mockResolvedValue({ success: false, message: "not-called" }),
}));

vi.mock("@/features/appointments/actions/booking-flow-actions", () => ({
  searchBookingCustomersAction: vi
    .fn()
    .mockResolvedValue({ success: true, customers: [] }),
}));

vi.mock("@/server/auth/guards", () => ({
  requireUser: vi.fn(),
  requireAdmin: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/customers",
}));

const FIXTURE_CUSTOMERS: CustomerListItem[] = [
  {
    id: "cust-1",
    name: "سارة عبد الله أحمد",
    phone: "+201012345678",
    lastConversationAt: "2026-10-28T14:30:00.000Z",
    lastAppointmentAt: "2026-10-29T10:00:00.000Z",
  },
];

describe("Customer dialog focus restoration", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
      root = null;
    }
    if (container.parentNode) {
      container.parentNode.removeChild(container);
    }
    // Clean any lingering dialog portals appended to document.body
    document.body.innerHTML = "";
    queryClient.clear();
  });

  function render(ui: React.ReactElement) {
    root = createRoot(container);
    act(() => {
      root?.render(
        <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
      );
    });
  }

  it("1. restores focus to primary 'إضافة عميل' button after Escape", async () => {
    render(<CustomersDirectory initialCustomers={FIXTURE_CUSTOMERS} />);

    const primaryBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="customers-primary-create-btn"]',
    );
    expect(primaryBtn).toBeTruthy();
    primaryBtn?.focus();
    expect(document.activeElement).toBe(primaryBtn);

    // Open dialog via primary button
    act(() => {
      primaryBtn?.click();
    });

    const dialogContent = document.body.querySelector(
      '[data-slot="dialog-content"]',
    );
    expect(dialogContent).toBeTruthy();

    // Close via Escape keydown on the dialog
    act(() => {
      dialogContent?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          code: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    // Run pending timers (Radix FocusScope unmount autofocus runs in setTimeout 0)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    // Focus MUST return to the primary button that opened the dialog
    expect(document.activeElement).toBe(primaryBtn);
  });

  it("2. restores focus to primary button after clicking close button (X)", async () => {
    render(<CustomersDirectory initialCustomers={FIXTURE_CUSTOMERS} />);

    const primaryBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="customers-primary-create-btn"]',
    );
    primaryBtn?.focus();

    act(() => {
      primaryBtn?.click();
    });

    const closeBtn = document.body.querySelector<HTMLButtonElement>(
      'button[data-slot="dialog-close"]',
    );
    expect(closeBtn).toBeTruthy();

    act(() => {
      closeBtn?.click();
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(document.activeElement).toBe(primaryBtn);
  });

  it("3. restores focus to primary button after clicking Cancel ('إلغاء')", async () => {
    render(<CustomersDirectory initialCustomers={FIXTURE_CUSTOMERS} />);

    const primaryBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="customers-primary-create-btn"]',
    );
    primaryBtn?.focus();

    act(() => {
      primaryBtn?.click();
    });

    const footerButtons = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>(
        'div[data-slot="dialog-footer"] button',
      ),
    );
    const cancelBtn = footerButtons.find((btn) =>
      btn.textContent?.includes("إلغاء"),
    );
    expect(cancelBtn).toBeTruthy();

    act(() => {
      cancelBtn?.click();
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(document.activeElement).toBe(primaryBtn);
  });

  it("4. restores focus to empty-state 'إضافة عميل' button after Escape and Cancel", async () => {
    render(<CustomersDirectory initialCustomers={[]} />);

    const emptyBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="customers-empty-create-btn"]',
    );
    expect(emptyBtn).toBeTruthy();
    emptyBtn?.focus();
    expect(document.activeElement).toBe(emptyBtn);

    // Open via empty state button
    act(() => {
      emptyBtn?.click();
    });

    const dialogContent = document.body.querySelector(
      '[data-slot="dialog-content"]',
    );
    expect(dialogContent).toBeTruthy();

    // Close via Escape
    act(() => {
      dialogContent?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          code: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(document.activeElement).toBe(emptyBtn);

    // Reopen and close via Cancel
    act(() => {
      emptyBtn?.click();
    });

    const footerButtons = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>(
        'div[data-slot="dialog-footer"] button',
      ),
    );
    const cancelBtn = footerButtons.find((btn) =>
      btn.textContent?.includes("إلغاء"),
    );
    expect(cancelBtn).toBeTruthy();

    act(() => {
      cancelBtn?.click();
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(document.activeElement).toBe(emptyBtn);
  });

  it("5. survives opener disconnection by falling back to primary button", async () => {
    const fallbackTarget = document.createElement("button");
    fallbackTarget.textContent = "fallback";
    document.body.appendChild(fallbackTarget);

    const ephemeralOpener = document.createElement("button");
    ephemeralOpener.textContent = "ephemeral";
    document.body.appendChild(ephemeralOpener);
    ephemeralOpener.focus();

    const returnFocusRef = { current: ephemeralOpener };
    const fallbackFocusRef = { current: fallbackTarget };

    let openState = true;
    const onOpenChange = vi.fn((val: boolean) => {
      openState = val;
    });

    const { rerender } = (() => {
      root = createRoot(container);
      const renderComponent = (isOpen: boolean) => {
        act(() => {
          root?.render(
            <CustomerFormDialog
              open={isOpen}
              onOpenChange={onOpenChange}
              onCreated={vi.fn()}
              returnFocusRef={returnFocusRef}
              fallbackFocusRef={fallbackFocusRef}
            />,
          );
        });
      };
      renderComponent(openState);
      return { rerender: renderComponent };
    })();

    // Disconnect ephemeral opener while dialog is open
    document.body.removeChild(ephemeralOpener);
    expect(ephemeralOpener.isConnected).toBe(false);

    // Close dialog
    act(() => {
      rerender(false);
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    // Because opener was disconnected, focus must fall back to the surviving target
    expect(document.activeElement).toBe(fallbackTarget);

    document.body.removeChild(fallbackTarget);
  });

  it("6. preserves Smart Create CustomerStep focus restoration", async () => {
    render(
      <CustomerStep
        initialCustomers={[]}
        selected={null}
        onSelect={vi.fn()}
        CreateCustomerDialog={CustomerFormDialog}
      />,
    );

    const emptyBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((btn) => btn.textContent?.includes("إضافة عميل جديد"));
    expect(emptyBtn).toBeTruthy();
    emptyBtn?.focus();

    act(() => {
      emptyBtn?.click();
    });

    const dialogContent = document.body.querySelector(
      '[data-slot="dialog-content"]',
    );
    expect(dialogContent).toBeTruthy();

    act(() => {
      dialogContent?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          code: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(document.activeElement).toBe(emptyBtn);
  });
});
