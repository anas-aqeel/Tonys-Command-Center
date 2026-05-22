// Shared helper to strip placeholder tokens that LLMs sometimes leak into
// drafted text (Tony's 2026-05-16 feedback: "Tokens Not filled out — check
// throughout — Hi {firstName}...").
//
// Applies to call follow-ups, email drafts, reply drafts, rewrites — anywhere
// we generate text on behalf of a contact. The model is also instructed in
// the prompt to use the actual name, but this is the safety net for the
// inevitable leaks.

export interface ContactLike {
  /** Full display name, e.g. "Andy Polock". */
  name: string;
  /** Optional first-name override. If not supplied, derived from name. */
  firstName?: string;
}

/**
 * Replace `{firstName}` / `{name}` / `{fullName}` placeholders (any case) in a
 * generated string with the supplied contact's real name. Idempotent: calling
 * twice produces the same result. Returns the input unchanged when the input
 * is empty / null / undefined.
 */
export function substituteContactTokens(text: string | null | undefined, contact: ContactLike): string {
  if (!text) return text ?? "";
  const firstName = contact.firstName?.trim() || contact.name.split(/\s+/)[0] || contact.name;
  return text
    .replace(/\{first[_]?name\}/gi, firstName)
    .replace(/\{full[_]?name\}/gi, contact.name)
    .replace(/\{name\}/gi, contact.name);
}
