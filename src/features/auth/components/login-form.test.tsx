/**
 * FlowPilot — Login Form Component Tests
 *
 * Verifies observable behavior of the real LoginForm:
 * 1. Empty/invalid submission shows the relevant email and password errors adjacent to each field.
 * 2. Invalid submission makes zero sign-in requests to authClient.
 * 3. Inputs reference their errors via aria-describedby and expose aria-invalid only when invalid.
 * 4. Focus moves to the first invalid input in form order (email first, password second).
 * 5. Editing one field clears only its stale field error without clearing an unrelated field's error.
 * 6. Remember-me is initially unchecked.
 * 7. Unchecked submission sends rememberMe: false; explicit selection sends rememberMe: true.
 * 8. Returned invalid-credentials error (401) is generic and recoverable in role="alert", preserving inputs.
 * 9. A rejected/thrown request displays a recoverable connection error and clears pending state.
 * 10. Retry can succeed after a failure.
 * 11. Rapid repeated submit makes only one request while pending.
 * 12. Successful sign-in redirect behavior: honors safe internal redirect and defaults to "/".
 * 13. Form-level error clears when credentials are edited.
 * 14. Unrelated re-renders (e.g. show/hide password toggle) keep active errors visible.
 */

import { LoginForm } from "@/features/auth/components/login-form";

import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockReplace, mockRefresh, mockSignInEmail } = vi.hoisted(() => ({
  mockReplace: vi.fn(),
  mockRefresh: vi.fn(),
  mockSignInEmail: vi.fn(),
}));

let mockRedirectParam: string | null = null;

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: mockReplace,
    refresh: mockRefresh,
  }),
  useSearchParams: () => ({
    get: (key: string) => (key === "redirect" ? mockRedirectParam : null),
  }),
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    signIn: {
      email: mockSignInEmail,
    },
  },
}));

describe("LoginForm Component Contract", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockReplace.mockReset();
    mockRefresh.mockReset();
    mockSignInEmail.mockReset();
    mockRedirectParam = null;
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

  function renderForm() {
    root = createRoot(container);
    act(() => {
      root?.render(<LoginForm />);
    });
  }

  function setInputValue(input: HTMLInputElement, value: string) {
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(input, value);
    } else {
      input.value = value;
    }
    act(() => {
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  function submitForm() {
    const form = container.querySelector<HTMLFormElement>("form");
    if (!form) throw new Error("Form not found");
    act(() => {
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
  }

  async function submitFormAsync() {
    const form = container.querySelector<HTMLFormElement>("form");
    if (!form) throw new Error("Form not found");
    await act(async () => {
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
  }

  it("1. shows relevant email and password errors on empty submission", () => {
    renderForm();

    submitForm();

    const emailError = container.querySelector("#email-error");
    const passwordError = container.querySelector("#password-error");

    expect(emailError?.textContent).toBe("بريد إلكتروني غير صالح");
    expect(passwordError?.textContent).toBe("كلمة المرور قصيرة جداً");
  });

  it("2. makes zero sign-in requests on invalid submission", () => {
    renderForm();

    submitForm();

    expect(mockSignInEmail).not.toHaveBeenCalled();
  });

  it("3. inputs reference their errors via aria-describedby and expose aria-invalid correctly", () => {
    renderForm();

    const emailInput = container.querySelector<HTMLInputElement>("#email")!;
    const passwordInput =
      container.querySelector<HTMLInputElement>("#password")!;

    // Initial state: no errors, no aria-invalid, no aria-describedby
    expect(emailInput.getAttribute("aria-invalid")).toBeNull();
    expect(emailInput.getAttribute("aria-describedby")).toBeNull();
    expect(passwordInput.getAttribute("aria-invalid")).toBeNull();
    expect(passwordInput.getAttribute("aria-describedby")).toBeNull();

    submitForm();

    // After invalid submit: aria-invalid set to true and aria-describedby points to stable error IDs
    expect(emailInput.getAttribute("aria-invalid")).toBe("true");
    expect(emailInput.getAttribute("aria-describedby")).toBe("email-error");
    expect(passwordInput.getAttribute("aria-invalid")).toBe("true");
    expect(passwordInput.getAttribute("aria-describedby")).toBe(
      "password-error",
    );
  });

  it("4. moves focus to the first invalid input in form order", () => {
    renderForm();

    const emailInput = container.querySelector<HTMLInputElement>("#email")!;
    const passwordInput =
      container.querySelector<HTMLInputElement>("#password")!;

    // Case A: Both invalid -> email receives focus
    submitForm();
    expect(document.activeElement).toBe(emailInput);

    // Case B: Email valid, password invalid -> password receives focus
    setInputValue(emailInput, "user@flowpilot.app");
    submitForm();
    expect(document.activeElement).toBe(passwordInput);
  });

  it("5. editing one field clears only its stale field error", () => {
    renderForm();

    const emailInput = container.querySelector<HTMLInputElement>("#email")!;
    const passwordInput =
      container.querySelector<HTMLInputElement>("#password")!;

    submitForm();

    expect(container.querySelector("#email-error")).not.toBeNull();
    expect(container.querySelector("#password-error")).not.toBeNull();

    // Edit email: email error clears, password error remains
    setInputValue(emailInput, "u");
    expect(container.querySelector("#email-error")).toBeNull();
    expect(emailInput.getAttribute("aria-invalid")).toBeNull();
    expect(container.querySelector("#password-error")).not.toBeNull();
    expect(passwordInput.getAttribute("aria-invalid")).toBe("true");

    // Edit password: password error clears
    setInputValue(passwordInput, "p");
    expect(container.querySelector("#password-error")).toBeNull();
    expect(passwordInput.getAttribute("aria-invalid")).toBeNull();
  });

  it("6. remember-me checkbox is initially unchecked", () => {
    renderForm();

    const checkbox = container.querySelector<HTMLButtonElement>("#rememberMe");
    expect(checkbox).not.toBeNull();
    expect(checkbox?.getAttribute("aria-checked")).toBe("false");
    expect(checkbox?.getAttribute("data-state")).toBe("unchecked");
  });

  it("7. unchecked submission sends rememberMe: false; explicit check sends true", async () => {
    mockSignInEmail.mockResolvedValue({ error: null });
    renderForm();

    const emailInput = container.querySelector<HTMLInputElement>("#email")!;
    const passwordInput =
      container.querySelector<HTMLInputElement>("#password")!;
    const checkbox = container.querySelector<HTMLButtonElement>("#rememberMe")!;

    setInputValue(emailInput, "staff@flowpilot.app");
    setInputValue(passwordInput, "example-password");

    // Unchecked submit
    await submitFormAsync();

    expect(mockSignInEmail).toHaveBeenCalledTimes(1);
    expect(mockSignInEmail).toHaveBeenCalledWith({
      email: "staff@flowpilot.app",
      password: "example-password",
      rememberMe: false,
    });

    // Toggle rememberMe on
    act(() => {
      checkbox.click();
    });
    expect(checkbox.getAttribute("data-state")).toBe("checked");

    await submitFormAsync();

    expect(mockSignInEmail).toHaveBeenCalledTimes(2);
    expect(mockSignInEmail).toHaveBeenLastCalledWith({
      email: "staff@flowpilot.app",
      password: "example-password",
      rememberMe: true,
    });
  });

  it("8. returned invalid-credentials error (401) is generic, preserves entered values, and is recoverable", async () => {
    mockSignInEmail.mockResolvedValue({
      error: { status: 401, message: "Unauthorized" },
    });
    renderForm();

    const emailInput = container.querySelector<HTMLInputElement>("#email")!;
    const passwordInput =
      container.querySelector<HTMLInputElement>("#password")!;

    setInputValue(emailInput, "unknown@flowpilot.app");
    setInputValue(passwordInput, "example-wrong-password");

    await submitFormAsync();

    const formError = container.querySelector("#login-form-error");
    expect(formError).not.toBeNull();
    expect(formError?.getAttribute("role")).toBe("alert");
    expect(formError?.textContent).toBe(
      "البريد الإلكتروني أو كلمة المرور غير صحيحة",
    );

    // Inputs remain intact
    expect(emailInput.value).toBe("unknown@flowpilot.app");
    expect(passwordInput.value).toBe("example-wrong-password");

    // Button is not disabled (submitting state is cleared)
    const submitBtn = container.querySelector<HTMLButtonElement>(
      "button[type='submit']",
    )!;
    expect(submitBtn.disabled).toBe(false);
  });

  it("9. rejected/thrown request displays a recoverable connection error and clears pending state", async () => {
    mockSignInEmail.mockRejectedValue(new Error("Network connection dropped"));
    renderForm();

    const emailInput = container.querySelector<HTMLInputElement>("#email")!;
    const passwordInput =
      container.querySelector<HTMLInputElement>("#password")!;

    setInputValue(emailInput, "user@flowpilot.app");
    setInputValue(passwordInput, "example-password");

    await submitFormAsync();

    const formError = container.querySelector("#login-form-error");
    expect(formError).not.toBeNull();
    expect(formError?.getAttribute("role")).toBe("alert");
    expect(formError?.textContent).toBe("تعذر الاتصال بالخادم، حاول مرة أخرى");

    const submitBtn = container.querySelector<HTMLButtonElement>(
      "button[type='submit']",
    )!;
    expect(submitBtn.disabled).toBe(false);
  });

  it("10. retry can succeed after an initial failure", async () => {
    mockSignInEmail
      .mockRejectedValueOnce(new Error("Network failure"))
      .mockResolvedValueOnce({ error: null });

    renderForm();

    const emailInput = container.querySelector<HTMLInputElement>("#email")!;
    const passwordInput =
      container.querySelector<HTMLInputElement>("#password")!;

    setInputValue(emailInput, "user@flowpilot.app");
    setInputValue(passwordInput, "example-password");

    // First attempt fails
    await submitFormAsync();
    expect(container.querySelector("#login-form-error")?.textContent).toBe(
      "تعذر الاتصال بالخادم، حاول مرة أخرى",
    );

    // Second attempt succeeds
    await submitFormAsync();
    expect(mockReplace).toHaveBeenCalledWith("/");
  });

  it("11. rapid repeated submit makes only one request while pending", async () => {
    let resolveSignIn: (val: unknown) => void = () => {};
    const pendingPromise = new Promise((resolve) => {
      resolveSignIn = resolve;
    });
    mockSignInEmail.mockReturnValue(pendingPromise);

    renderForm();

    const emailInput = container.querySelector<HTMLInputElement>("#email")!;
    const passwordInput =
      container.querySelector<HTMLInputElement>("#password")!;

    setInputValue(emailInput, "user@flowpilot.app");
    setInputValue(passwordInput, "example-password");

    // Fire two submits synchronously before the first resolves
    act(() => {
      submitForm();
      submitForm();
    });

    expect(mockSignInEmail).toHaveBeenCalledTimes(1);

    // Resolve in-flight request
    await act(async () => {
      resolveSignIn({ error: null });
    });
  });

  it("12. existing successful redirect behavior remains intact", async () => {
    mockRedirectParam = "/admin/team";
    mockSignInEmail.mockResolvedValue({ error: null });
    renderForm();

    const emailInput = container.querySelector<HTMLInputElement>("#email")!;
    const passwordInput =
      container.querySelector<HTMLInputElement>("#password")!;

    setInputValue(emailInput, "admin@flowpilot.app");
    setInputValue(passwordInput, "example-password");

    await submitFormAsync();

    expect(mockReplace).toHaveBeenCalledWith("/admin/team");
    expect(mockRefresh).toHaveBeenCalled();
  });

  it("12b. sanitizes control-character, protocol-relative, backslash, and auth-screen redirects to '/'", async () => {
    for (const unsafeRedirect of [
      "/\t/evil.example",
      "/\n/evil.example",
      "/\\evil.example",
      "//evil.example",
      "/sign-in",
      "/sign-up",
      "/admin/../sign-in",
      "/sign-in?nested=1",
    ]) {
      mockReplace.mockReset();
      mockRefresh.mockReset();
      mockRedirectParam = unsafeRedirect;
      mockSignInEmail.mockResolvedValue({ error: null });
      renderForm();

      const emailInput = container.querySelector<HTMLInputElement>("#email")!;
      const passwordInput =
        container.querySelector<HTMLInputElement>("#password")!;

      setInputValue(emailInput, "admin@flowpilot.app");
      setInputValue(passwordInput, "example-password");

      await submitFormAsync();

      expect(mockReplace).toHaveBeenCalledWith("/");
      expect(mockRefresh).toHaveBeenCalled();
    }
  });

  it("13. clears previous form-level authentication error when credentials are edited", async () => {
    mockSignInEmail.mockResolvedValue({
      error: { status: 401, message: "Unauthorized" },
    });
    renderForm();

    const emailInput = container.querySelector<HTMLInputElement>("#email")!;
    const passwordInput =
      container.querySelector<HTMLInputElement>("#password")!;

    setInputValue(emailInput, "wrong@flowpilot.app");
    setInputValue(passwordInput, "example-wrong-password");

    await submitFormAsync();
    expect(container.querySelector("#login-form-error")).not.toBeNull();

    // Editing email clears the form error
    setInputValue(emailInput, "new@flowpilot.app");
    expect(container.querySelector("#login-form-error")).toBeNull();
  });

  it("14. keeps active errors visible during unrelated re-renders (show/hide password)", () => {
    renderForm();

    submitForm();
    expect(container.querySelector("#email-error")).not.toBeNull();
    expect(container.querySelector("#password-error")).not.toBeNull();

    // Toggle password visibility button
    const toggleBtn = container.querySelector<HTMLButtonElement>(
      "button[aria-label='إظهار كلمة المرور']",
    );
    expect(toggleBtn).not.toBeNull();

    act(() => {
      toggleBtn?.click();
    });

    // Errors remain intact after re-render
    expect(container.querySelector("#email-error")).not.toBeNull();
    expect(container.querySelector("#password-error")).not.toBeNull();
  });
});
