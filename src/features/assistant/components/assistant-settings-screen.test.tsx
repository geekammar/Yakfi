/**
 * Assistant Settings Screen — F01 Response Detail Lifecycle & Form Verification.
 *
 * Mounts the real `AssistantSettingsScreen` in jsdom against a mocked server action
 * boundary (`updateAssistantSettingsAction`). Verifies the real React Hook Form
 * lifecycle, dirty tracking, disabled Save button state, and submitted payload:
 *
 *   a) unset/null detail: inherited-default badge & explanation, initially clean,
 *      Save disabled, and no automatic write.
 *   b) explicit "short" remains distinguishable from inherited "short" (badge & radio selection).
 *   c) explicit "balanced" renders correctly (badge & radio selection).
 *   d) editing only the name enables Save; submitting through the actual form captures
 *      the payload with detail remaining undefined (never silently coerced to "short").
 *   e) selecting a detail option updates visible distinction from inherited to explicit,
 *      marks form dirty, and submits the explicit value.
 */
import { AssistantSettingsScreen } from "@/features/assistant/components/assistant-settings-screen";
import { HANDOFF_BEHAVIORS } from "@/features/assistant/server/handoff-behaviors";
import type { AssistantSettingsView } from "@/features/assistant/types";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { updateAssistantSettingsAction, markKnowledgeGapReviewedAction } =
  vi.hoisted(() => ({
    updateAssistantSettingsAction: vi.fn(),
    markKnowledgeGapReviewedAction: vi.fn(),
  }));

vi.mock("@/features/assistant/actions/assistant-actions", () => ({
  updateAssistantSettingsAction,
  markKnowledgeGapReviewedAction,
}));

describe("AssistantSettingsScreen — F01 Response Detail & Form Verification", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
    updateAssistantSettingsAction.mockResolvedValue({ success: true });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  async function renderScreen(settings: Partial<AssistantSettingsView> = {}) {
    const initialSettings: AssistantSettingsView = {
      name: "",
      language: null,
      tone: null,
      detail: null,
      emoji: null,
      ...settings,
    };

    await act(async () => {
      root.render(
        <AssistantSettingsScreen
          initialSettings={initialSettings}
          handoffBehaviors={HANDOFF_BEHAVIORS}
          initialGaps={[]}
        />,
      );
    });

    return { container };
  }

  function setInputValue(input: HTMLInputElement, value: string) {
    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    );
    descriptor?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  it("a) unset/null detail: displays inherited-default explanation, initially clean, Save disabled, and no automatic write", async () => {
    await renderScreen({ detail: null });

    const detailSection = container.querySelector(
      "section[aria-labelledby='assistant-detail-section']",
    );
    expect(detailSection).not.toBeNull();

    // Verify badge shows inherited default
    const badge = detailSection?.querySelector("[data-slot='badge']");
    expect(badge?.textContent).toBe("افتراضي موروث (مختصر)");

    // Verify explanation copy describes system default
    expect(detailSection?.textContent).toContain(
      "يستخدم المساعد حاليًا الوضع الافتراضي العام للنظام (مختصر: جملة أو جملتين فقط)",
    );

    // Verify no radio item is checked in response detail group
    const checkedDetailRadio = detailSection?.querySelector(
      "[data-slot='radio-group-item'][data-state='checked']",
    );
    expect(checkedDetailRadio).toBeNull();

    // Form is initially clean and Save button is disabled
    const saveButton = container.querySelector(
      "button[type='submit']",
    ) as HTMLButtonElement;
    expect(saveButton).not.toBeNull();
    expect(saveButton.disabled).toBe(true);
    expect(container.textContent).toContain("لا توجد تعديلات غير محفوظة.");

    // No automatic persistence action was fired
    expect(updateAssistantSettingsAction).not.toHaveBeenCalled();
  });

  it("b) explicit 'short' remains distinguishable from inherited 'short'", async () => {
    await renderScreen({ detail: "short" });

    const detailSection = container.querySelector(
      "section[aria-labelledby='assistant-detail-section']",
    );
    expect(detailSection).not.toBeNull();

    // Verify badge distinguishes explicit override
    const badge = detailSection?.querySelector("[data-slot='badge']");
    expect(badge?.textContent).toBe("تخصيص صريح");

    // Verify explanation states explicit override
    expect(detailSection?.textContent).toContain(
      "تم تحديد طول الردود بتخصيص صريح لهذه المنشأة.",
    );

    // Verify the "short" radio item is checked
    const shortRadio = container.querySelector("#assistant-detail-short");
    expect(shortRadio).not.toBeNull();
    expect(shortRadio?.getAttribute("data-state")).toBe("checked");

    // Other options remain unchecked
    const balancedRadio = container.querySelector("#assistant-detail-balanced");
    expect(balancedRadio?.getAttribute("data-state")).toBe("unchecked");

    // Save button is disabled on mount (persisted value matches form)
    const saveButton = container.querySelector(
      "button[type='submit']",
    ) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);
  });

  it("c) explicit 'balanced' renders correctly", async () => {
    await renderScreen({ detail: "balanced" });

    const detailSection = container.querySelector(
      "section[aria-labelledby='assistant-detail-section']",
    );
    expect(detailSection).not.toBeNull();

    // Verify badge and explanation
    const badge = detailSection?.querySelector("[data-slot='badge']");
    expect(badge?.textContent).toBe("تخصيص صريح");
    expect(detailSection?.textContent).toContain(
      "تم تحديد طول الردود بتخصيص صريح لهذه المنشأة.",
    );

    // Verify balanced radio item is checked and short is unchecked
    const balancedRadio = container.querySelector("#assistant-detail-balanced");
    expect(balancedRadio?.getAttribute("data-state")).toBe("checked");

    const shortRadio = container.querySelector("#assistant-detail-short");
    expect(shortRadio?.getAttribute("data-state")).toBe("unchecked");

    const saveButton = container.querySelector(
      "button[type='submit']",
    ) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);
  });

  it("d) editing only the name enables Save; submitting captures action payload where detail remains undefined", async () => {
    await renderScreen({ name: "", detail: null });

    const nameInput = container.querySelector(
      "#assistant-name",
    ) as HTMLInputElement;
    const saveButton = container.querySelector(
      "button[type='submit']",
    ) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);

    // Edit only the assistant name
    await act(async () => {
      setInputValue(nameInput, "مساعد عيادة النور");
    });

    // Save button must now be enabled and form marked dirty
    expect(saveButton.disabled).toBe(false);
    expect(container.textContent).toContain(
      "لن يتم حفظ التعديلات إلا بعد الضغط على زر الحفظ.",
    );

    // Submit the form through the actual button
    await act(async () => {
      saveButton.click();
    });

    // Action was called with real payload
    expect(updateAssistantSettingsAction).toHaveBeenCalledTimes(1);
    const submittedPayload = updateAssistantSettingsAction.mock.calls[0]![0];

    expect(submittedPayload.name).toBe("مساعد عيادة النور");
    // CRITICAL: detail must remain undefined/absent, NOT silently coerced to "short"
    expect(submittedPayload.detail).toBeUndefined();
  });

  it("e) selecting a detail option updates the visible distinction and submits the explicit value", async () => {
    await renderScreen({ name: "مساعد أفنان", detail: null });

    const detailSection = container.querySelector(
      "section[aria-labelledby='assistant-detail-section']",
    );
    // Initially shows inherited default
    expect(detailSection?.textContent).toContain("افتراضي موروث (مختصر)");

    const saveButton = container.querySelector(
      "button[type='submit']",
    ) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);

    // User selects the "balanced" detail option in the form
    const balancedRadio = container.querySelector(
      "#assistant-detail-balanced",
    ) as HTMLElement;

    await act(async () => {
      balancedRadio.click();
    });

    // Visible distinction immediately updates to explicit override
    const badge = detailSection?.querySelector("[data-slot='badge']");
    expect(badge?.textContent).toBe("تخصيص صريح");
    expect(detailSection?.textContent).toContain(
      "تم تحديد طول الردود بتخصيص صريح لهذه المنشأة.",
    );
    expect(balancedRadio.getAttribute("data-state")).toBe("checked");

    // Form is now dirty and Save button is enabled
    expect(saveButton.disabled).toBe(false);

    // Submit through actual form button
    await act(async () => {
      saveButton.click();
    });

    expect(updateAssistantSettingsAction).toHaveBeenCalledTimes(1);
    const submittedPayload = updateAssistantSettingsAction.mock.calls[0]![0];

    // Payload includes the explicit choice
    expect(submittedPayload.name).toBe("مساعد أفنان");
    expect(submittedPayload.detail).toBe("balanced");
  });
});
