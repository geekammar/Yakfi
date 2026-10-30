/**
 * FlowPilot — Provider Dialog Policy & Interaction Tests (ISS-003)
 *
 * Verifies that:
 * 1. Stored SPECIFIC_SERVICES policy displays localized badge ("خدمات محددة") and no raw enum tokens.
 * 2. Upgrade to all services checkbox remains visible and reversible before saving.
 * 3. Checking the upgrade checkbox displays the pending upgrade notice stating it applies on Save.
 * 4. Unchecking the upgrade checkbox cleanly undoes the pending upgrade.
 * 5. Submitting with the upgrade checked calls updateProviderAction with servicePolicy: "ALL_SERVICES".
 * 6. Closing/cancelling and reopening resets the pending upgrade.
 * 7. Editing unrelated fields (e.g. name) without checking upgrade does NOT broaden policy or pass servicePolicy.
 * 8. Stored ALL_SERVICES policy displays localized badge ("جميع الخدمات تلقائياً") and no raw enum tokens.
 */

import { ProviderDialog } from "@/features/staff/components/provider-dialog";
import type { ProviderItem } from "@/features/staff/types";

import type { ReactElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createProviderActionMock, updateProviderActionMock } = vi.hoisted(
  () => ({
    createProviderActionMock: vi.fn(),
    updateProviderActionMock: vi.fn(),
  }),
);

vi.mock("@/features/staff/actions/team-actions", () => ({
  createProviderAction: createProviderActionMock,
  updateProviderAction: updateProviderActionMock,
}));

const MOCK_SERVICES = [
  { id: "srv-1", name: "كشف أولي" },
  { id: "srv-2", name: "تنظيف أسنان" },
];

const MOCK_BRANCHES = [
  { id: "br-1", name: "الفرع الرئيسي" },
  { id: "br-2", name: "فرع المعادي" },
];

const MOCK_SPECIFIC_PROVIDER: ProviderItem = {
  id: "prov-specific-1",
  name: "د. خالد السعيد",
  displayName: "د. خالد",
  servicePolicy: "SPECIFIC_SERVICES",
  isActive: true,
  userId: null,
  user: null,
  branchId: "br-1",
  branchName: "الفرع الرئيسي",
  excludedServiceIds: [],
  excludedServiceNames: [],
  includedServiceIds: ["srv-1"],
  includedServiceNames: ["كشف أولي"],
};

const MOCK_ALL_SERVICES_PROVIDER: ProviderItem = {
  id: "prov-all-1",
  name: "د. سارة عثمان",
  displayName: "د. سارة",
  servicePolicy: "ALL_SERVICES",
  isActive: true,
  userId: null,
  user: null,
  branchId: "br-1",
  branchName: "الفرع الرئيسي",
  excludedServiceIds: ["srv-2"],
  excludedServiceNames: ["تنظيف أسنان"],
  includedServiceIds: ["srv-1"],
  includedServiceNames: ["كشف أولي"],
};

describe("ProviderDialog interaction and policy upgrade tests (ISS-003)", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.clearAllMocks();

    updateProviderActionMock.mockResolvedValue({
      success: true,
      provider: MOCK_SPECIFIC_PROVIDER,
    });
    createProviderActionMock.mockResolvedValue({
      success: true,
      provider: MOCK_SPECIFIC_PROVIDER,
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
    document.body.innerHTML = "";
  });

  async function renderComponent(ui: ReactElement) {
    if (!root) {
      root = createRoot(container);
    }
    const activeRoot = root;
    await act(async () => {
      activeRoot.render(ui);
    });
  }

  it("1. renders SPECIFIC_SERVICES with localized label and no raw enum tokens", async () => {
    await renderComponent(
      <ProviderDialog
        open={true}
        onOpenChange={vi.fn()}
        mode="edit"
        provider={MOCK_SPECIFIC_PROVIDER}
        services={MOCK_SERVICES}
        branches={MOCK_BRANCHES}
        members={[]}
        onSaved={vi.fn()}
      />,
    );

    // Natural Arabic copy instead of raw token
    expect(document.body.textContent).toContain("خدمات محددة");
    expect(document.body.textContent).not.toContain("SPECIFIC_SERVICES");

    // Upgrade checkbox is present and unchecked
    const upgradeCheckbox = document.body.querySelector(
      "#upgrade-to-all-services",
    ) as HTMLInputElement | null;
    expect(upgradeCheckbox).not.toBeNull();
    expect(upgradeCheckbox?.getAttribute("aria-checked")).toBe("false");
  });

  it("2. select and undo: keeps upgrade visible and reversible before save", async () => {
    await renderComponent(
      <ProviderDialog
        open={true}
        onOpenChange={vi.fn()}
        mode="edit"
        provider={MOCK_SPECIFIC_PROVIDER}
        services={MOCK_SERVICES}
        branches={MOCK_BRANCHES}
        members={[]}
        onSaved={vi.fn()}
      />,
    );

    const upgradeCheckbox = document.body.querySelector(
      "#upgrade-to-all-services",
    ) as HTMLButtonElement | HTMLInputElement | null;
    expect(upgradeCheckbox).not.toBeNull();

    // Check the upgrade checkbox
    await act(async () => {
      upgradeCheckbox?.click();
    });

    // Checkbox is still mounted and now checked
    expect(upgradeCheckbox?.getAttribute("aria-checked")).toBe("true");
    // Clear Arabic notice that upgrade applies on save
    expect(document.body.textContent).toContain(
      "سيتم تطبيق الترقية إلى جميع الخدمات تلقائياً عند الضغط على حفظ.",
    );
    expect(document.body.textContent).toContain("ترقية معلقة");

    // Uncheck to undo
    await act(async () => {
      upgradeCheckbox?.click();
    });

    // Cleanly reverted before save
    expect(upgradeCheckbox?.getAttribute("aria-checked")).toBe("false");
    expect(document.body.textContent).not.toContain(
      "سيتم تطبيق الترقية إلى جميع الخدمات تلقائياً عند الضغط على حفظ.",
    );
  });

  it("3. saves policy upgrade when confirmed with the upgrade checkbox checked", async () => {
    const onSavedMock = vi.fn();

    await renderComponent(
      <ProviderDialog
        open={true}
        onOpenChange={vi.fn()}
        mode="edit"
        provider={MOCK_SPECIFIC_PROVIDER}
        services={MOCK_SERVICES}
        branches={MOCK_BRANCHES}
        members={[]}
        onSaved={onSavedMock}
      />,
    );

    const upgradeCheckbox = document.body.querySelector(
      "#upgrade-to-all-services",
    ) as HTMLButtonElement | null;
    await act(async () => {
      upgradeCheckbox?.click();
    });

    // Click submit
    const submitBtn = Array.from(document.body.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("حفظ التعديلات"),
    );
    expect(submitBtn).toBeDefined();

    await act(async () => {
      submitBtn?.click();
    });

    expect(updateProviderActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: MOCK_SPECIFIC_PROVIDER.id,
        servicePolicy: "ALL_SERVICES",
      }),
    );
    expect(onSavedMock).toHaveBeenCalled();
  });

  it("4. cancel / reopen resets the pending upgrade checkbox", async () => {
    const onOpenChangeMock = vi.fn();

    await renderComponent(
      <ProviderDialog
        open={true}
        onOpenChange={onOpenChangeMock}
        mode="edit"
        provider={MOCK_SPECIFIC_PROVIDER}
        services={MOCK_SERVICES}
        branches={MOCK_BRANCHES}
        members={[]}
        onSaved={vi.fn()}
      />,
    );

    const upgradeCheckbox = document.body.querySelector(
      "#upgrade-to-all-services",
    ) as HTMLButtonElement | null;
    await act(async () => {
      upgradeCheckbox?.click();
    });

    expect(upgradeCheckbox?.getAttribute("aria-checked")).toBe("true");

    // Close dialog
    const cancelBtn = Array.from(document.body.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("إلغاء"),
    );
    await act(async () => {
      cancelBtn?.click();
    });
    expect(onOpenChangeMock).toHaveBeenCalledWith(false);

    // Reopen dialog with open={false} then open={true}
    await renderComponent(
      <ProviderDialog
        open={false}
        onOpenChange={onOpenChangeMock}
        mode="edit"
        provider={MOCK_SPECIFIC_PROVIDER}
        services={MOCK_SERVICES}
        branches={MOCK_BRANCHES}
        members={[]}
        onSaved={vi.fn()}
      />,
    );

    await renderComponent(
      <ProviderDialog
        open={true}
        onOpenChange={onOpenChangeMock}
        mode="edit"
        provider={MOCK_SPECIFIC_PROVIDER}
        services={MOCK_SERVICES}
        branches={MOCK_BRANCHES}
        members={[]}
        onSaved={vi.fn()}
      />,
    );

    const reopenedCheckbox = document.body.querySelector(
      "#upgrade-to-all-services",
    ) as HTMLButtonElement | null;
    expect(reopenedCheckbox?.getAttribute("aria-checked")).toBe("false");
    expect(document.body.textContent).not.toContain(
      "سيتم تطبيق الترقية إلى جميع الخدمات تلقائياً عند الضغط على حفظ.",
    );
  });

  it("5. unrelated-field save without upgrade does NOT broaden policy", async () => {
    await renderComponent(
      <ProviderDialog
        open={true}
        onOpenChange={vi.fn()}
        mode="edit"
        provider={MOCK_SPECIFIC_PROVIDER}
        services={MOCK_SERVICES}
        branches={MOCK_BRANCHES}
        members={[]}
        onSaved={vi.fn()}
      />,
    );

    // Change name only
    const nameInput = document.body.querySelector(
      "#provider-name-input",
    ) as HTMLInputElement | null;
    expect(nameInput).not.toBeNull();

    await act(async () => {
      if (nameInput) {
        nameInput.value = "د. خالد السعيد المحدث";
        nameInput.dispatchEvent(new Event("input", { bubbles: true }));
        nameInput.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });

    // Submit without checking upgrade
    const submitBtn = Array.from(document.body.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("حفظ التعديلات"),
    );
    await act(async () => {
      submitBtn?.click();
    });

    // updateProviderAction must NOT receive servicePolicy
    expect(updateProviderActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: MOCK_SPECIFIC_PROVIDER.id,
        name: "د. خالد السعيد المحدث",
      }),
    );
    const calledArgs = updateProviderActionMock.mock.calls[0]?.[0];
    expect(calledArgs.servicePolicy).toBeUndefined();
    expect(calledArgs.excludedServiceIds).toBeUndefined();
  });

  it("6. renders ALL_SERVICES with localized label and no raw enum tokens", async () => {
    await renderComponent(
      <ProviderDialog
        open={true}
        onOpenChange={vi.fn()}
        mode="edit"
        provider={MOCK_ALL_SERVICES_PROVIDER}
        services={MOCK_SERVICES}
        branches={MOCK_BRANCHES}
        members={[]}
        onSaved={vi.fn()}
      />,
    );

    expect(document.body.textContent).toContain("جميع الخدمات تلقائياً");
    expect(document.body.textContent).not.toContain("ALL_SERVICES");
    // No upgrade checkbox when already ALL_SERVICES
    expect(document.body.querySelector("#upgrade-to-all-services")).toBeNull();
  });
});
