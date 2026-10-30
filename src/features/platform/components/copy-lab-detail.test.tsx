/**
 * Founder Conversation Lab — ENTRY DETAIL LIFECYCLE (UX-LAB-01D-P1 / B2).
 *
 * Why this file exists: `pnpm check:copy-lab` is a static / pure-function
 * gate. It was green (125/125) while B1 was live, because it never mounts the
 * React component and therefore could not observe the real defect — the
 * first-open effect applied the server result but never settled `loading`, so
 * the drawer stayed on the loading branch forever: no EffectiveStateBlock, no
 * CopyEditor, and an entry like `greeting.invite` looked non-editable to a
 * human on Production.
 *
 * This mounts the REAL `CopyLabDetail` in jsdom against a mocked server
 * boundary (the actions module is the only seam, and it is mocked so the test
 * needs no database, no provider, no network, and no customer path) and proves
 * the contract:
 *
 *   P1  an editable entry shows genuine loading while the read is in flight
 *   P2  loading settles after the read resolves
 *   P3  the EFFECTIVE STATE read back from the boundary becomes visible
 *   P4  CopyEditor renders for EDITABLE_COPY and EDITABLE_TEMPLATE
 *   P5  a failed read settles into the safe fallback state, not stuck loading
 *   P6  PROTECTED_COPY renders its state but never exposes editing controls
 *
 * Against the pre-patch (B1) implementation, P2/P3/P4/P5 fail: `loading` never
 * becomes false, so the loading branch keeps rendering and neither the
 * effective state nor the editor can appear.
 */
import { COPY_REGISTRY } from "@/features/conversation-copy/index";
import type { CopyRegistryEntry } from "@/features/conversation-copy/types";
import { AiReadinessCard } from "@/features/dashboard/components/ai-readiness-card";
import type { GetCopyLabEntryStateResult } from "@/features/platform/actions/copy-lab-actions";
import { CopyLabDetail } from "@/features/platform/components/copy-lab-detail";
import { getPublishFeedbackText } from "@/features/platform/components/copy-lab-logic";
import { SettingsScreen } from "@/features/settings/components/settings-screen";
import type { BusinessSettingsView } from "@/features/settings/types";

import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Test fixtures ─────────────────────────────────────────────────────────────

/**
 * The ONLY seam the detail component has to the persistence layer. Mocking it
 * keeps this a pure UI-lifecycle test: no DB, no provider, no network, and the
 * customer runtime stays unwired (the mocked module is never imported by any
 * reply path here).
 *
 * `vi.hoisted` puts the mock functions above the component's own imports, so
 * `vi.mock` can reference them without a hoisting-order violation.
 */
const {
  getCopyLabEntryStateAction,
  publishCopyOverrideAction,
  resetCopyOverrideAction,
  restoreCopyOverrideAction,
} = vi.hoisted(() => ({
  getCopyLabEntryStateAction:
    vi.fn<(key: string) => Promise<GetCopyLabEntryStateResult>>(),
  publishCopyOverrideAction: vi.fn(),
  resetCopyOverrideAction: vi.fn(),
  restoreCopyOverrideAction: vi.fn(),
}));

vi.mock("@/features/platform/actions/copy-lab-actions", () => ({
  getCopyLabEntryStateAction,
  publishCopyOverrideAction,
  resetCopyOverrideAction,
  restoreCopyOverrideAction,
}));

vi.mock("@/features/settings/actions/settings-actions", () => ({
  updateBusinessSettingsAction: vi.fn().mockResolvedValue({ success: true }),
}));

/** A non-registry effective text, so the test proves the READ data lands. */
const EFFECTIVE_TEXT = "نص فعلي عائد من طبقة الخدمة — اختبار الدورة";
/** An override text that must seed the editor when a published row exists. */
const PUBLISHED_TEXT = "نص منشور من اختبار الدورة";

function findEntry(key: string): CopyRegistryEntry {
  const entry = COPY_REGISTRY.find(
    (item: CopyRegistryEntry) => item.key === key,
  ) as CopyRegistryEntry | undefined;
  if (!entry) throw new Error(`registry has no ${key}`);
  return entry;
}

/** A successful boundary read: code default in effect, no published row. */
function successState(entry: CopyRegistryEntry): GetCopyLabEntryStateResult {
  return {
    success: true,
    data: {
      resolution: {
        ok: true,
        key: entry.key,
        text: EFFECTIVE_TEXT,
        source: "CODE_DEFAULT",
        fallbackReason: "NO_OVERRIDE",
      },
      published: { success: true, data: { override: null } },
      history: { success: true, data: { items: [] } },
    },
  };
}

/** A successful read that also carries a published platform override. */
function successWithOverride(
  entry: CopyRegistryEntry,
): GetCopyLabEntryStateResult {
  return {
    success: true,
    data: {
      resolution: {
        ok: true,
        key: entry.key,
        text: PUBLISHED_TEXT,
        source: "PLATFORM_OVERRIDE",
      },
      published: {
        success: true,
        data: {
          override: {
            id: "override-1",
            copyKey: entry.key,
            text: PUBLISHED_TEXT,
            actorId: "platform-operator-1",
            updatedAt: "2026-10-09T12:00:00.000Z",
          },
        },
      },
      history: { success: true, data: { items: [] } },
    },
  };
}

/** The typed FORBIDDEN refusal the boundary returns for a non-platform actor. */
function forbiddenState(): GetCopyLabEntryStateResult {
  return {
    success: false,
    error: {
      code: "FORBIDDEN",
      message: "هذه الصلاحية متاحة لمشغل المنصة فقط",
    },
  };
}

/** A successful read carrying one restorable history row. */
function successWithHistoryItem(
  entry: CopyRegistryEntry,
  historyId: string,
  resultText: string,
): GetCopyLabEntryStateResult {
  return {
    success: true,
    data: {
      resolution: {
        ok: true,
        key: entry.key,
        text: EFFECTIVE_TEXT,
        source: "CODE_DEFAULT",
      },
      published: { success: true, data: { override: null } },
      history: {
        success: true,
        data: {
          items: [
            {
              id: historyId,
              copyKey: entry.key,
              action: "PUBLISH",
              previousText: null,
              resultText,
              actorId: "platform-operator-1",
              createdAt: "2026-10-09T10:00:00.000Z",
            },
          ],
        },
      },
    },
  };
}

// ── Minimal render harness (no testing-library dependency) ────────────────────

/** The Arabic labels the component renders; asserted by tests. */
const EFFECTIVE_HEADING = "النص الفعلي";
const EDITOR_LABEL = "التعديل";
const PROTECTED_NOTICE = "نص محمي — غير قابل للتعديل";
const LOAD_FAILED_HEADING = "تعذّر قراءة حالة النص";
const PUBLISH_LABEL = "نشر النص";
const RESET_LABEL = "إعادة التعيين للنص الافتراضي";
const RESTORE_LABEL = "استرجاع هذه القيمة";

function renderDetail(
  entry: CopyRegistryEntry,
  onOpenChange: (open: boolean) => void = () => {},
): {
  unmount: () => void;
} {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <CopyLabDetail entry={entry} open={true} onOpenChange={onOpenChange} />,
    );
  });
  return {
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/** Flush the async effect work so awaited boundary reads land. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function text(): string {
  return document.body.textContent ?? "";
}

/** The loading branch renders exactly one `role="status"` block. */
function loadingBlock(): Element | null {
  return document.querySelector('[role="status"]');
}

function editorTextarea(): HTMLTextAreaElement | null {
  return document.querySelector("textarea");
}

function typeInEditor(textarea: HTMLTextAreaElement, value: string): void {
  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  nativeSetter?.call(textarea, value);
  textarea.dispatchEvent(new Event("change", { bubbles: true }));
}

function findButton(textMatch: string): HTMLButtonElement | null {
  return (
    (Array.from(document.querySelectorAll("button")).find((button) =>
      button.textContent?.includes(textMatch),
    ) as HTMLButtonElement | undefined) ?? null
  );
}

beforeEach(() => {
  getCopyLabEntryStateAction.mockReset();
  publishCopyOverrideAction.mockReset();
  resetCopyOverrideAction.mockReset();
  restoreCopyOverrideAction.mockReset();
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("CopyLabDetail first-open lifecycle (UX-LAB-01D-P1)", () => {
  it("P1. shows genuine loading while the effective-state read is in flight", async () => {
    const entry = findEntry("greeting.invite");
    // Never resolves: the read stays in flight for the whole assertion.
    getCopyLabEntryStateAction.mockImplementation(
      () => new Promise<GetCopyLabEntryStateResult>(() => {}),
    );
    renderDetail(entry);

    expect(
      loadingBlock(),
      "loading block must render while the read is pending",
    ).not.toBeNull();
    expect(editorTextarea(), "no editor while loading").toBeNull();
    expect(
      text(),
      "effective state is not shown before the read resolves",
    ).not.toContain(EFFECTIVE_TEXT);
  });

  it("P2–P4. settles after the read and renders the effective state + editor for EDITABLE_COPY", async () => {
    const entry = findEntry("greeting.invite");
    getCopyLabEntryStateAction.mockResolvedValue(successState(entry));
    renderDetail(entry);

    // The read resolves on a microtask; settle the effect.
    await settle();

    expect(
      loadingBlock(),
      "loading must settle after a successful read",
    ).toBeNull();
    expect(text(), "the effective state section must render").toContain(
      EFFECTIVE_HEADING,
    );
    expect(
      text(),
      "the text read from the boundary must become visible",
    ).toContain(EFFECTIVE_TEXT);
    expect(
      editorTextarea(),
      "CopyEditor must render for EDITABLE_COPY",
    ).not.toBeNull();
    expect(text(), "the editor section must be labelled").toContain(
      EDITOR_LABEL,
    );
  });

  it("P4. seeds the editor from the published override for EDITABLE_COPY", async () => {
    const entry = findEntry("greeting.invite");
    getCopyLabEntryStateAction.mockResolvedValue(successWithOverride(entry));
    renderDetail(entry);

    await settle();

    const textarea = editorTextarea();
    expect(
      textarea,
      "CopyEditor must render for a published editable entry",
    ).not.toBeFalsy();
    expect(
      textarea?.value,
      "the editor seeds from the published override",
    ).toBe(PUBLISHED_TEXT);
    expect(text(), "the source badge flips to the platform override").toContain(
      "تجاوز المنصة",
    );
  });

  it("P4. renders the editor for an EDITABLE_TEMPLATE with placeholders", async () => {
    const entry = findEntry("booking.offer");
    expect(entry.classification).toBe("EDITABLE_TEMPLATE");
    getCopyLabEntryStateAction.mockResolvedValue(successState(entry));
    renderDetail(entry);

    await settle();

    expect(loadingBlock()).toBeNull();
    expect(
      editorTextarea(),
      "CopyEditor must render for EDITABLE_TEMPLATE",
    ).not.toBeNull();
    // The template's declared placeholder must appear as a preview input.
    expect(document.querySelector("input[id^='copy-lab-ph-']")).not.toBeNull();
  });

  it("P5. settles into the safe fallback when the boundary refuses the actor", async () => {
    const entry = findEntry("greeting.invite");
    getCopyLabEntryStateAction.mockResolvedValue(forbiddenState());
    renderDetail(entry);

    await settle();

    expect(
      loadingBlock(),
      "a refused read must not stay stuck on loading",
    ).toBeNull();
    expect(text(), "the safe fallback notice must render").toContain(
      LOAD_FAILED_HEADING,
    );
    expect(
      editorTextarea(),
      "no editor when the state could not be read",
    ).toBeNull();
  });

  it("P5. settles into the safe fallback when the boundary throws", async () => {
    const entry = findEntry("greeting.invite");
    getCopyLabEntryStateAction.mockRejectedValue(new Error("persistence down"));
    renderDetail(entry);

    await settle();

    expect(
      loadingBlock(),
      "a thrown read must not stay stuck on loading",
    ).toBeNull();
    expect(text()).toContain(LOAD_FAILED_HEADING);
  });

  it("P6. renders the effective state but exposes no editing controls for PROTECTED_COPY", async () => {
    const entry = findEntry("handoff.human_request");
    expect(entry.classification).toBe("PROTECTED_COPY");
    getCopyLabEntryStateAction.mockResolvedValue(successState(entry));
    renderDetail(entry);

    await settle();

    expect(loadingBlock()).toBeNull();
    expect(text(), "protected copy still shows its effective state").toContain(
      EFFECTIVE_HEADING,
    );
    expect(text(), "the read-only notice must render").toContain(
      PROTECTED_NOTICE,
    );
    expect(
      editorTextarea(),
      "PROTECTED_COPY must never render an editor",
    ).toBeNull();
    expect(text(), "no publish control for PROTECTED_COPY").not.toContain(
      PUBLISH_LABEL,
    );
    expect(text(), "no reset control for PROTECTED_COPY").not.toContain(
      RESET_LABEL,
    );
    expect(text(), "no restore control for PROTECTED_COPY").not.toContain(
      RESTORE_LABEL,
    );
  });

  it("P6. keeps every PROTECTED_COPY entry non-editable across the registry", async () => {
    const protectedEntries = COPY_REGISTRY.filter(
      (item: CopyRegistryEntry) => item.classification === "PROTECTED_COPY",
    ) as CopyRegistryEntry[];
    // The registry contract this patch must not change: exactly 4 protected.
    expect(protectedEntries).toHaveLength(4);

    for (const entry of protectedEntries) {
      getCopyLabEntryStateAction.mockReset();
      getCopyLabEntryStateAction.mockResolvedValue(successState(entry));
      const { unmount } = renderDetail(entry);
      await settle();

      expect(
        editorTextarea(),
        `${entry.key} must not render an editor`,
      ).toBeNull();
      expect(text(), `${entry.key} must not offer publishing`).not.toContain(
        PUBLISH_LABEL,
      );
      expect(
        text(),
        `${entry.key} must still show its effective state`,
      ).toContain(EFFECTIVE_HEADING);
      unmount();
    }
  });
});

describe("CopyLabDetail drawer touch contract (UX-LAB-01D-P1 / B3)", () => {
  /**
   * The Close control's Arabic label; the footer also renders Publish / Reset,
   * which must stay plain tappable buttons.
   */
  const CLOSE_LABEL = "إغلاق";

  function closeButton(): HTMLButtonElement | null {
    return (
      (Array.from(document.querySelectorAll("button")).find((button) =>
        button.textContent?.includes(CLOSE_LABEL),
      ) as HTMLButtonElement | undefined) ?? null
    );
  }

  /**
   * The class Vaul puts on the drawer while it owns a drag. It is the visible
   * sign that the drawer surface — not the button — captured the gesture.
   */
  const VAUL_DRAGGING_CLASS = "vaul-dragging";

  function dispatchPointer(
    target: Element,
    type: "pointerdown" | "pointermove" | "pointerup",
    pageY: number,
  ): void {
    const event = new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      pointerType: "touch",
      isPrimary: true,
    });
    // jsdom performs no layout, so the touch coordinates are set explicitly.
    Object.defineProperty(event, "pageY", { value: pageY });
    Object.defineProperty(event, "pageX", { value: 0 });
    target.dispatchEvent(event);
  }

  it("B3-a. restricts drawer drag to the explicit handle and keeps the Close control", async () => {
    const onOpenChange = vi.fn();
    const entry = findEntry("greeting.invite");
    getCopyLabEntryStateAction.mockResolvedValue(successState(entry));
    renderDetail(entry, onOpenChange);

    await settle();

    // The Lab opts into Vaul's `handleOnly`, so a real `<Drawer.Handle>` must
    // be present as the sole drag affordance.
    expect(
      document.querySelector("[data-vaul-handle]"),
      "the drawer must expose Vaul's real drag handle",
    ).not.toBeNull();

    // The Close control keeps its Drawer.Close semantics: a plain tap closes.
    const close = closeButton();
    expect(close, "the Close control must render in the footer").not.toBeNull();
    await act(async () => {
      close!.click();
    });
    expect(
      onOpenChange,
      "Drawer.Close must still request onOpenChange(false)",
    ).toHaveBeenCalledWith(false);
  });

  it("B3-b. a footer button tap with vertical movement does not become a drawer drag", async () => {
    const onOpenChange = vi.fn();
    const entry = findEntry("greeting.invite");
    getCopyLabEntryStateAction.mockResolvedValue(successState(entry));
    renderDetail(entry, onOpenChange);

    await settle();

    const close = closeButton();
    expect(close).not.toBeNull();
    const drawer = document.querySelector("[data-vaul-drawer]");

    // Vaul refuses drags for 500ms after open ("allow scrolling while
    // animating"), so the gesture must happen past that window or it is
    // blocked for an unrelated reason and the assertion is vacuous.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });

    // Reproduces the reported gesture shape: a press on the bottom-edge Close
    // control that drifts downward. Before the fix the whole drawer surface
    // was a drag target, so Vaul captured the pointer and the tap never fired
    // a click.
    dispatchPointer(close as Element, "pointerdown", 600);
    // Let Vaul's `isDragging` state flush, the way a real browser spaces the
    // events apart.
    await act(async () => {
      await Promise.resolve();
    });
    dispatchPointer(close as Element, "pointermove", 680);
    dispatchPointer(close as Element, "pointerup", 680);

    expect(
      drawer?.classList.contains(VAUL_DRAGGING_CLASS),
      "the drawer must not take over a footer button tap as a drag",
    ).toBe(false);
    expect(
      drawer?.getAttribute("style") ?? "",
      "the drawer must not be translated by a footer tap",
    ).not.toContain("translate3d");
    // The gesture was a tap attempt, not a swipe past the close threshold, so
    // the drawer must not have closed on its own.
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

describe("Conversation Lab Runtime Coverage & Honest Wording", () => {
  it("shows connected runtime coverage badge and scope for welcome.intro", async () => {
    const entry = findEntry("welcome.intro");
    getCopyLabEntryStateAction.mockResolvedValue(successState(entry));
    renderDetail(entry);
    await settle();

    const content = text();
    expect(content, "connected badge must render").toContain("متصل بالمحادثة");
    expect(content, "connected scope must explain /start turn").toContain(
      "مقدمة الترحيب عند بدء محادثة جديدة أو خاملة عبر أمر /start",
    );
    expect(
      content,
      "connected scope must clarify button and continuation isolation",
    ).toContain("لا يغيّر أزرار الخيارات ولا مسار استئناف الحجز النشط");
    expect(
      content,
      "must state platform overrides are platform-wide",
    ).toContain("التجاوزات المنشورة تسري على مستوى كافة المنشآت");
  });

  it("shows unwired coverage badge and honest stored-resolution guidance for unwired keys", async () => {
    const entry = findEntry("greeting.invite");
    getCopyLabEntryStateAction.mockResolvedValue(successState(entry));
    renderDetail(entry);
    await settle();

    const content = text();
    expect(content, "unwired badge must render").toContain("غير متصل بعد");
    expect(
      content,
      "must clarify publishing does not change live replies",
    ).toContain("الحفظ أو النشر في مخزن المنصة لا يغيّر الردود الحية للعملاء");
    expect(
      content,
      "authoring, preview, history and restore remain available",
    ).toContain(
      "تظل إمكانية التعديل والمعاينة وسجل التعديلات والاسترجاع متاحة",
    );
  });

  it("maintains strict independence of PROTECTED_COPY from runtime connection", async () => {
    const entry = findEntry("handoff.human_request");
    getCopyLabEntryStateAction.mockResolvedValue(successState(entry));
    renderDetail(entry);
    await settle();

    const content = text();
    expect(content, "renders unwired badge").toContain("غير متصل بعد");
    expect(content, "renders protected notice").toContain(
      "نص محمي — غير قابل للتعديل",
    );
    expect(
      editorTextarea(),
      "never renders editor for protected entry",
    ).toBeNull();
    expect(content, "no publish button for protected entry").not.toContain(
      "نشر النص",
    );
  });

  it("honest publish feedback distinguishes connected vs unwired stored resolution", () => {
    const welcome = getPublishFeedbackText(
      "welcome.intro",
      "PLATFORM_OVERRIDE",
    );
    const unwired = getPublishFeedbackText(
      "greeting.invite",
      "PLATFORM_OVERRIDE",
    );

    expect(welcome).toContain("مسار /start للمحادثة الجديدة/الخاملة");
    expect(welcome).toContain("لا يعني ذلك التحقق من تسليم المزود");
    expect(unwired).toContain("غير متصل بالمحادثة الحية بعد");
    expect(unwired).toContain("لن تتغير ردود العملاء الحية حالياً");
  });
});

describe("Conversation Lab Protected Guidance & Mutation Feedback Lifecycle (PR66 Review)", () => {
  it("protected guidance contains no promise of editing/restoring and no mutation controls", async () => {
    const entry = findEntry("handoff.human_request");
    expect(entry.classification).toBe("PROTECTED_COPY");
    getCopyLabEntryStateAction.mockResolvedValue(successState(entry));
    renderDetail(entry);
    await settle();

    const content = text();
    expect(content).toContain("هذا النص محمي لحماية مسارات التحويل الآمن");
    expect(content).toContain(
      "ولا تتوفر له عمليات التعديل أو النشر أو إعادة التعيين أو الاسترجاع في مخزن المنصة",
    );
    expect(content).not.toContain("تظل إمكانية التعديل");
    expect(content).not.toContain(PUBLISH_LABEL);
    expect(content).not.toContain(RESET_LABEL);
    expect(content).not.toContain(RESTORE_LABEL);
    expect(editorTextarea()).toBeNull();
  });

  it("editable unwired guidance still explains available authoring features", async () => {
    const entry = findEntry("greeting.invite");
    expect(entry.classification).toBe("EDITABLE_COPY");
    getCopyLabEntryStateAction.mockResolvedValue(successState(entry));
    renderDetail(entry);
    await settle();

    const content = text();
    expect(content).toContain("غير متصل بعد");
    expect(content).toContain(
      "الحفظ أو النشر في مخزن المنصة لا يغيّر الردود الحية للعملاء",
    );
    expect(content).toContain(
      "تظل إمكانية التعديل والمعاينة وسجل التعديلات والاسترجاع متاحة",
    );
    expect(editorTextarea()).not.toBeNull();
    expect(findButton(PUBLISH_LABEL)).not.toBeNull();
  });

  it("successful publish feedback survives completed readback", async () => {
    const entry = findEntry("greeting.invite");
    getCopyLabEntryStateAction.mockResolvedValue(successState(entry));
    renderDetail(entry);
    await settle();

    const textarea = editorTextarea();
    expect(textarea).not.toBeNull();
    act(() => {
      typeInEditor(textarea!, "تعديل جديد للترحيب");
    });

    publishCopyOverrideAction.mockResolvedValue({
      success: true,
      data: {
        id: "ov-test",
        copyKey: entry.key,
        text: "تعديل جديد للترحيب",
        actorId: "operator",
        updatedAt: "2026-10-30T12:00:00.000Z",
      },
    });
    getCopyLabEntryStateAction.mockResolvedValue(successWithOverride(entry));

    const publishBtn = findButton(PUBLISH_LABEL);
    expect(publishBtn).not.toBeNull();

    await act(async () => {
      publishBtn!.click();
    });
    await settle();

    const content = text();
    expect(content).toContain("تم حفظ التجاوز في مخزن المنصة");
    expect(content).toContain("تجاوز المنصة");
    expect(content).toContain("لن تتغير ردود العملاء الحية حالياً");

    // Clearing stale feedback on subsequent draft edit
    act(() => {
      typeInEditor(textarea!, "تعديل إضافي بعد النشر");
    });
    expect(text()).not.toContain("تم حفظ التجاوز في مخزن المنصة");
  });

  it("reset feedback is operation-correct and survives readback", async () => {
    const entry = findEntry("greeting.invite");
    getCopyLabEntryStateAction.mockResolvedValue(successWithOverride(entry));
    renderDetail(entry);
    await settle();

    const resetBtn = findButton(RESET_LABEL);
    expect(resetBtn).not.toBeNull();
    await act(async () => {
      resetBtn!.click();
    });

    const confirmBtn = findButton("تأكيد الحذف");
    expect(confirmBtn).not.toBeNull();

    resetCopyOverrideAction.mockResolvedValue({
      success: true,
      data: { reset: true },
    });
    getCopyLabEntryStateAction.mockResolvedValue(successState(entry));

    await act(async () => {
      confirmBtn!.click();
    });
    await settle();

    const content = text();
    expect(content).toContain("تمت إعادة التعيين في مخزن المنصة وحذف التجاوز");
    expect(content).toContain(
      "يعود النص المعتمد في المخزن إلى الافتراضي في الكود",
    );
    expect(content).not.toContain("تم حفظ التجاوز");
    expect(content).not.toContain("تم نشر التجاوز");
    expect(content).toContain("لن تتغير ردود العملاء الحية حالياً");
  });

  it("restore feedback is operation-correct and survives readback", async () => {
    const entry = findEntry("greeting.invite");
    getCopyLabEntryStateAction.mockResolvedValue(
      successWithHistoryItem(entry, "hist-123", "نص مسترجع من السجل"),
    );
    renderDetail(entry);
    await settle();

    const restoreBtn = findButton(RESTORE_LABEL);
    expect(restoreBtn).not.toBeNull();

    restoreCopyOverrideAction.mockResolvedValue({
      success: true,
      data: { restored: true },
    });
    getCopyLabEntryStateAction.mockResolvedValue(successWithOverride(entry));

    await act(async () => {
      restoreBtn!.click();
    });
    await settle();

    expect(restoreCopyOverrideAction).toHaveBeenCalledWith({
      historyId: "hist-123",
    });
    const content = text();
    expect(content).toContain("تم استرجاع النسخة المحددة في مخزن المنصة");
    expect(content).not.toContain("تم حفظ التجاوز");
    expect(content).not.toContain("تم نشر التجاوز");
    expect(content).toContain("لن تتغير ردود العملاء الحية حالياً");
  });

  it("mutation failure does not display success", async () => {
    const entry = findEntry("greeting.invite");
    getCopyLabEntryStateAction.mockResolvedValue(successState(entry));
    renderDetail(entry);
    await settle();

    const textarea = editorTextarea();
    expect(textarea).not.toBeNull();
    act(() => {
      typeInEditor(textarea!, "تعديل سيفشل");
    });

    publishCopyOverrideAction.mockResolvedValue({
      success: false,
      error: {
        code: "PERSISTENCE_FAILED",
        message: "فشلت كتابة التجاوز في قاعدة البيانات",
      },
    });

    const publishBtn = findButton(PUBLISH_LABEL);
    expect(publishBtn).not.toBeNull();

    await act(async () => {
      publishBtn!.click();
    });
    await settle();

    const content = text();
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    expect(content).toContain("تعذر الاتصال بمخزن النصوص الآن");
    expect(content).toContain("PERSISTENCE_FAILED");
    expect(content).not.toContain("تم حفظ التجاوز");
    expect(content).not.toContain("تم نشر التجاوز");
    expect(content).not.toContain("بنجاح");
  });

  it("successful mutation followed by failed readback displays an honest, distinct result", async () => {
    const entry = findEntry("greeting.invite");
    getCopyLabEntryStateAction.mockResolvedValue(successState(entry));
    renderDetail(entry);
    await settle();

    const textarea = editorTextarea();
    expect(textarea).not.toBeNull();
    act(() => {
      typeInEditor(textarea!, "تعديل ينجح مع فشل القراءة الراجعة");
    });

    publishCopyOverrideAction.mockResolvedValue({
      success: true,
      data: {
        id: "ov-ok",
        copyKey: entry.key,
        text: "تعديل ينجح مع فشل القراءة الراجعة",
        actorId: "operator",
        updatedAt: "2026-10-30T12:00:00.000Z",
      },
    });
    getCopyLabEntryStateAction.mockRejectedValue(
      new Error("readback network down"),
    );

    const publishBtn = findButton(PUBLISH_LABEL);
    expect(publishBtn).not.toBeNull();

    await act(async () => {
      publishBtn!.click();
    });
    await settle();

    const content = text();
    expect(content).toContain(
      "تم حفظ التعديل بنجاح في مخزن المنصة، لكن تعذر تحديث عرض الحالة الحالية فوراً",
    );
    expect(content).toContain("دون إثبات قراءة راجعة");
  });
});

describe("Muse Spacing Observations Real Component Verification", () => {
  it("renders DOM whitespace around assistantName and استقبال in AiReadinessCard (NOT REPRODUCED)", async () => {
    const readyItems = [
      {
        key: "about",
        label: "نبذة عن النشاط",
        status: "complete" as const,
        statusLabel: "مكتمل",
        optional: false,
        href: "/settings",
      },
      {
        key: "hours",
        label: "أوقات العمل",
        status: "complete" as const,
        statusLabel: "مكتمل",
        optional: false,
        href: "/onboarding/hours",
      },
      {
        key: "services",
        label: "الخدمات",
        status: "complete" as const,
        statusLabel: "مكتمل",
        optional: false,
        href: "/services",
      },
    ];

    // Case 1: with named assistant "سارة"
    const c1 = document.createElement("div");
    document.body.appendChild(c1);
    const r1 = createRoot(c1);
    act(() => {
      r1.render(<AiReadinessCard items={readyItems} assistantName="سارة" />);
    });
    await settle();

    const text1 = c1.textContent ?? "";
    expect(text1).toContain("ويمكن لـسارة استقبال العملاء.");
    expect(text1).toMatch(/لـسارة استقبال/);
    act(() => {
      r1.unmount();
    });
    c1.remove();

    // Case 2: fallback assistant name "المساعد الذكي"
    const c2 = document.createElement("div");
    document.body.appendChild(c2);
    const r2 = createRoot(c2);
    act(() => {
      r2.render(<AiReadinessCard items={readyItems} assistantName={null} />);
    });
    await settle();

    const text2 = c2.textContent ?? "";
    expect(text2).toContain("ويمكن لـالمساعد الذكي استقبال العملاء.");
    expect(text2).toMatch(/المساعد الذكي استقبال/);
    act(() => {
      r2.unmount();
    });
    c2.remove();
  });

  it("renders DOM whitespace around خدمة and selected service name in SettingsScreen booking preview (NOT REPRODUCED)", async () => {
    const initialSettings: BusinessSettingsView = {
      name: "عيادة الأمل",
      vertical: "clinic",
      city: "القاهرة",
      whatsappNumber: "+201000000000",
      timezone: "Africa/Cairo",
      about: "",
      address: "",
      slotDurationMinutes: 30,
      confirmationMode: "automatic",
      cancellationPolicy: "",
      defaultServiceBookingEnabled: true,
      defaultBookingServiceId: "srv-1",
      reminderEnabled: false,
      reminderLeadHours: 24,
      reminderTemplateId: "standard",
      remindersOperational: false,
      channelReadiness: {
        whatsapp: false,
        telegram: false,
        hasActiveChannel: false,
      },
    };
    const services = [{ id: "srv-1", name: "كشف واستشارة", isActive: true }];

    const c = document.createElement("div");
    document.body.appendChild(c);
    const r = createRoot(c);
    act(() => {
      r.render(
        <SettingsScreen
          initialSettings={initialSettings}
          services={services}
        />,
      );
    });
    await settle();

    const rendered = c.textContent ?? "";
    expect(rendered).toContain("على خدمة كشف واستشارة.");
    expect(rendered).toMatch(/على خدمة كشف واستشارة\.\s*تقدر/);

    act(() => {
      r.unmount();
    });
    c.remove();
  });
});
