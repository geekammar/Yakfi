/**
 * Derive create-form defaults from a customer search the user already
 * typed (B-07 post-ship polish) — pure, presentational, and reuses the
 * SAME validation the create form + server enforce. It belongs outside
 * the dialog component so it stays free of client/UI dependencies.
 */

import { customerFormSchema } from "@/features/customers/schemas/customer-schema";
import { phoneSchema } from "@/lib/validation";

/** A phone-shaped token anywhere inside free text — the substring form
 * of `phoneSchema`, used to locate a number the user already typed
 * (optionally surrounded by a name). */
const PHONE_LIKE = /\+?[0-9][0-9\s-]{7,19}/;

/**
 * Carry the text a user already typed into a customer search across into
 * the create form so nothing valid is re-typed:
 * - the whole query is a phone → phone only;
 * - a phone token appears inside the query → that token is the phone and
 *   the remaining text is the name;
 * - otherwise the query is a name candidate.
 *
 * Every candidate is checked against the SAME validation the form
 * enforces (`phoneSchema` / the create schema's name), and the server
 * re-validates on submit — an invalid candidate is dropped rather than
 * carried, so prefilling can never bypass the canonical write path's
 * rules. Business identity is never derived here (the action derives it
 * from the authenticated session).
 */
export function deriveCustomerFormDefaults(query: string): {
  name: string;
  phone: string;
} {
  const nameSchema = customerFormSchema.shape.name;
  const trimmed = query.trim();
  if (!trimmed) return { name: "", phone: "" };

  if (phoneSchema.safeParse(trimmed).success) {
    return { name: "", phone: trimmed };
  }

  const match = trimmed.match(PHONE_LIKE);
  if (match && match.index !== undefined) {
    const phone = match[0].trim();
    const rest = (
      trimmed.slice(0, match.index) +
      trimmed.slice(match.index + match[0].length)
    ).trim();
    return {
      name: nameSchema.safeParse(rest).success ? rest : "",
      phone: phoneSchema.safeParse(phone).success ? phone : "",
    };
  }

  return {
    name: nameSchema.safeParse(trimmed).success ? trimmed : "",
    phone: "",
  };
}
