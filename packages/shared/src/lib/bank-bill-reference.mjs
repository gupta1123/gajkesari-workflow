const token = value => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const serial = value => String(value).replace(/^0+(?=\d)/, "");
const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Resolve references only within the selected party's open bills. */
export function resolveBankBillReference(bills, { narration = "", referenceNumber = "" } = {}) {
  const result = (status, matches = [], matchKind = null) => ({
    status,
    referenceName: status === "matched" ? matches[0].referenceName : null,
    candidateReferences: [...new Set(matches.map(bill => bill.referenceName))],
    matchKind,
  });
  const text = `${narration} ${referenceNumber}`;
  const compact = token(text);
  const positions = [...text.matchAll(/[a-z0-9]/gi)].map(match => match.index);
  const identity = value => String(value).trim().toLowerCase().replace(/\s+/g, " ");
  const unique = [...new Map((bills || []).map(bill => [identity(bill.referenceName), bill])).values()];
  const full = unique.filter(bill => {
    const ref = token(bill.referenceName);
    if (ref.length < 5) return false;
    if (/^\d+$/.test(ref)) return new RegExp(`(^|[^a-z0-9])${escaped(ref)}(?=$|[^a-z0-9])`, "i").test(narration);
    let offset = compact.indexOf(ref);
    while (offset >= 0) {
      const tail = text.slice(positions[offset + ref.length - 1] + 1);
      // A following amount separated by whitespace is not part of the invoice.
      // An immediately appended digit or /-number is a longer reference.
      if (!/\d$/.test(ref) || !/^(?:\d|[/-]\s*\d)/.test(tail)) return true;
      offset = compact.indexOf(ref, offset + 1);
    }
    return false;
  });
  // A full reference may contain a shorter bill's reference. Keep the most
  // specific match, but never choose between unrelated visible references.
  const specific = full.filter(bill => !full.some(other => token(other.referenceName).length > token(bill.referenceName).length && token(other.referenceName).startsWith(token(bill.referenceName))));
  if (specific.length) return result(specific.length === 1 ? "matched" : "ambiguous", specific, "full");

  const parts = unique.map(bill => {
    const name = String(bill.referenceName || "").trim();
    return { bill, prefix: name.match(/^([a-z]{2,})/i)?.[1]?.toLowerCase(), number: name.match(/(\d+)$/)?.[1] };
  });
  const prefixes = [...new Set(["invoice", "inv", "bill", ...parts.map(part => part.prefix).filter(Boolean)])].sort((a,b) => b.length-a.length);
  const pattern = new RegExp(`(?:${prefixes.map(escaped).join("|")})(?:\\s*(?:number|no\\.?|reference|ref))?[\\s:#/-]*(\\d+(?:\\s*[/\\-]\\s*\\d+)*)(?!\\d)`, "gi");
  const mentions = [...String(narration).matchAll(pattern)];
  if (!mentions.length) return result("none");
  const candidates = new Map();
  let unresolved = false;
  for (const mention of mentions) {
    const numbers = mention[1].split(/\s*[/\-]\s*/);
    // A printed fiscal year is significant. Do not reduce an unmatched full
    // year/reference to a serial number from another financial year.
    if (numbers.length !== 1) { unresolved = true; continue; }
    const prefix = mention[0].match(/^[a-z]+/i)?.[0].toLowerCase();
    const matches = parts.filter(part => part.number && serial(part.number) === serial(numbers[0]) &&
      (part.prefix === prefix || (["invoice", "inv"].includes(prefix) && ["invoice", "inv"].includes(part.prefix))));
    if (!matches.length) unresolved = true;
    for (const part of matches) candidates.set(identity(part.bill.referenceName), part.bill);
  }
  const matches = [...candidates.values()];
  if (unresolved) return result("unresolved", matches, "short");
  return result(matches.length === 1 ? "matched" : "ambiguous", matches, "short");
}
