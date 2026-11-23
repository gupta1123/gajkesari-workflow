// apps/gajkesari-web/src/lib/cash-discount-scope-ledgers.ts
var key = (value) => String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
function groupsUnder(roots, groups, includeNested) {
  const result = new Set(roots.map(key));
  if (!includeNested) return result;
  for (let changed = true; changed; ) {
    changed = false;
    for (const group of groups) {
      if (!result.has(key(group.name)) && group.parent && result.has(key(group.parent))) {
        result.add(key(group.name));
        changed = true;
      }
    }
  }
  return result;
}
function resolveScopedLedgers(masters, scope) {
  const included = groupsUnder(scope.selectedGroupNames, masters.groups, scope.includeNestedGroups);
  const excludedGroups = groupsUnder(scope.excludedGroupNames, masters.groups, scope.includeNestedGroups);
  const excludedLedgers = new Set(scope.excludedLedgerNames.map(key));
  const seen = /* @__PURE__ */ new Set();
  return masters.ledgers.filter((ledger) => {
    const id = key(ledger.name);
    if (!id || seen.has(id)) return false;
    const parent = key(ledger.parent);
    if (!included.has(parent) || excludedGroups.has(parent) || excludedLedgers.has(id)) return false;
    seen.add(id);
    return true;
  });
}

// apps/api/src/lib/followups-dashboard.ts
function followUpsDashboard(input) {
  return {
    setupRequired: input.setupRequired ?? false,
    company: input.company,
    kpis: Object.fromEntries(["unpaidInvoices", "partialUnpaidInvoices", "paymentFollowUps", "paymentFollowUpAmount"].map((key2) => [key2, input.kpis?.[key2] ?? 0])),
    tabs: { overduePayments: [], paymentFollowUps: input.tabs?.paymentFollowUps ?? [], cashDiscountTracker: [], debitNoteQueue: [] },
    notes: []
  };
}

// apps/api/src/lib/business-date.ts
var DEFAULT_BUSINESS_TIME_ZONE = "Asia/Kolkata";
function businessDateText(date = /* @__PURE__ */ new Date(), timeZone = DEFAULT_BUSINESS_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

// apps/api/src/lib/payment-terms.ts
function classifyPaymentNarration(value) {
  const text = String(value ?? "").toUpperCase().replace(/\bR[.\s]*T[.\s]*G[.\s]*S\b/g, "RTGS").replace(/[.\s_-]+/g, " ").trim();
  if (text.startsWith("CASH DISCOUNT RECOVERY AGAINST INVOICE")) return { category: null, ambiguous: false };
  const advance = /\bADVANCE RTGS\b/.test(text);
  const sameDay = /\bSAME DAY RTGS\b/.test(text);
  if (advance && sameDay) return { category: null, ambiguous: true };
  return { category: advance ? "advance_rtgs" : sameDay ? "same_day_rtgs" : null, ambiguous: false };
}
function isNonSalesVoucher(type) {
  return ["debitnote", "creditnote", "receipt", "payment", "journal", "purchase", "contra"].includes(String(type ?? "").toLowerCase().replace(/[\s_-]+/g, ""));
}
function validPaymentDate(value) {
  const text = String(value ?? "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const time = Date.parse(`${text}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === text ? text : null;
}
function collectionPaymentRequirement(narration, invoiceDate) {
  const parsed = classifyPaymentNarration(narration);
  return parsed.ambiguous ? null : paymentRequirement(parsed.category ?? "regular_credit", invoiceDate);
}
function paymentRequirement(category, invoiceDate) {
  const date = validPaymentDate(invoiceDate);
  if (!date) return null;
  const eligibilityDays = category === "regular_credit" ? 30 : category === "advance_rtgs" ? -1 : 0;
  const deadline = new Date(Date.parse(`${date}T00:00:00Z`) + eligibilityDays * 864e5).toISOString().slice(0, 10);
  return {
    category,
    ratePercent: category === "regular_credit" ? 0 : category === "advance_rtgs" ? 1.5 : 1,
    eligibilityDays,
    deadline,
    label: category === "regular_credit" ? "Payment within 30 days" : category === "advance_rtgs" ? "1.5% \u2014 payment before invoice date" : "1% \u2014 payment on invoice date",
    // Midnight in IST after the last qualifying payment date.
    followUpStartsAt: new Date(Date.parse(`${deadline}T00:00:00+05:30`) + 864e5).toISOString()
  };
}

// apps/api/src/lib/cash-discount-narration.ts
var SUPPORTED_CASH_DISCOUNT_RATES = [1.5, 1];
function asMoney(value) {
  return Math.round(value * 100) / 100;
}
function moneyClose(left, right) {
  return Math.abs(left - right) <= 1;
}
function isCashDiscountRecoveryStatus(status) {
  return status === "unpaid_discount_tier_expired" || status === "late_payment_discount_expired";
}
function addDays(dateText, days) {
  const date = /* @__PURE__ */ new Date(`${dateText}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
function isAfterDate(left, right) {
  return Date.parse(`${left}T00:00:00.000Z`) > Date.parse(`${right}T00:00:00.000Z`);
}
function normalizeTerms(terms) {
  const byRate = /* @__PURE__ */ new Map();
  for (const term of terms) {
    const ratePercent = Number(term.ratePercent);
    const eligibilityDays = Math.trunc(Number(term.eligibilityDays));
    if (!Number.isFinite(ratePercent) || !Number.isFinite(eligibilityDays)) continue;
    if (!isSupportedCashDiscountRate(ratePercent) || eligibilityDays < (term.paymentCategory === "advance_rtgs" ? -1 : 0) || eligibilityDays > 365) continue;
    const existing = byRate.get(ratePercent);
    if (!existing || existing.periodSource === "default" && term.periodSource === "explicit") {
      byRate.set(ratePercent, {
        ratePercent,
        eligibilityDays,
        periodSource: term.periodSource,
        paymentCategory: term.paymentCategory
      });
    }
  }
  return Array.from(byRate.values()).sort(
    (left, right) => left.eligibilityDays - right.eligibilityDays || right.ratePercent - left.ratePercent
  );
}
function isSupportedCashDiscountRate(value) {
  return SUPPORTED_CASH_DISCOUNT_RATES.some((rate) => Math.abs(rate - value) < 1e-4);
}
function formatCashDiscountTerms(terms) {
  return terms.map((term) => term.paymentCategory === "advance_rtgs" ? "1.5% \u2014 payment before invoice date" : term.paymentCategory === "same_day_rtgs" ? "1% \u2014 payment on invoice date" : `${Number(term.ratePercent).toLocaleString("en-IN", { maximumFractionDigits: 2 })}% within ${term.eligibilityDays} days`).join("; ");
}
function currentCashDiscountEligibility(input) {
  const invoiceDate = validPaymentDate(input.invoiceDate);
  if (!invoiceDate || !Number.isFinite(input.originalAmount) || input.originalAmount <= 0) return null;
  const eligible = normalizeTerms(input.terms).map((term) => ({
    term,
    discountDeadline: addDays(invoiceDate, term.eligibilityDays)
  })).filter((entry) => Boolean(entry.discountDeadline)).filter((entry) => !isAfterDate(input.today, entry.discountDeadline));
  if (eligible.length === 0) return null;
  const best = eligible.reduce(
    (current, entry) => entry.term.ratePercent > current.term.ratePercent || entry.term.ratePercent === current.term.ratePercent && entry.term.eligibilityDays < current.term.eligibilityDays ? entry : current
  );
  return {
    ratePercent: best.term.ratePercent,
    eligibilityDays: best.term.eligibilityDays,
    periodSource: best.term.periodSource,
    discountDeadline: best.discountDeadline,
    discountAmount: asMoney(input.originalAmount * best.term.ratePercent / 100)
  };
}
function initialCashDiscountEligibility(input) {
  const invoiceDate = String(input.invoiceDate ?? "").slice(0, 10);
  if (!invoiceDate || !Number.isFinite(input.grossInvoiceAmount) || input.grossInvoiceAmount <= 0) return null;
  const terms = normalizeTerms(input.terms);
  if (terms.length === 0) return null;
  const best = terms.reduce(
    (current, term) => term.ratePercent > current.ratePercent || term.ratePercent === current.ratePercent && term.eligibilityDays < current.eligibilityDays ? term : current
  );
  const discountDeadline = addDays(invoiceDate, best.eligibilityDays);
  if (!discountDeadline) return null;
  return {
    ratePercent: best.ratePercent,
    eligibilityDays: best.eligibilityDays,
    periodSource: best.periodSource,
    discountDeadline,
    discountAmount: asMoney(input.grossInvoiceAmount * best.ratePercent / 100)
  };
}
function createUnpaidReversalPlan(input) {
  const terms = normalizeTerms(input.terms);
  const highestRate = terms.reduce((maximum, term) => Math.max(maximum, term.ratePercent), 0);
  if (!Number.isFinite(input.invoiceNetAmount) || input.invoiceNetAmount <= 0 || highestRate <= 0 || highestRate >= 100) {
    return null;
  }
  const grossInvoiceAmount = asMoney(input.invoiceNetAmount / (1 - highestRate / 100));
  const initialDiscount = initialCashDiscountEligibility({
    terms,
    invoiceDate: input.invoiceDate,
    grossInvoiceAmount
  });
  if (!initialDiscount) return null;
  const activeDiscount = currentCashDiscountEligibility({
    terms,
    invoiceDate: input.invoiceDate,
    originalAmount: grossInvoiceAmount,
    today: input.today
  });
  const currentPayableAmount = asMoney(grossInvoiceAmount - (activeDiscount?.discountAmount ?? 0));
  return {
    initialDiscount,
    grossInvoiceAmount,
    activeDiscount,
    currentPayableAmount,
    totalReversalRequired: asMoney(Math.max(currentPayableAmount - input.invoiceNetAmount, 0))
  };
}
function parseCashDiscountNarration(sourceNarration) {
  const parsed = classifyPaymentNarration(sourceNarration);
  const category = parsed.category;
  const ratePercent = category === "advance_rtgs" ? 1.5 : 1;
  const terms = category ? [{ ratePercent, eligibilityDays: category === "advance_rtgs" ? -1 : 0, periodSource: "explicit", paymentCategory: category }] : [];
  return {
    matchedCashDiscountContext: category === "advance_rtgs" ? "ADVANCE RTGS" : category === "same_day_rtgs" ? "SAME DAY RTGS" : parsed.ambiguous ? "Conflicting RTGS terms" : null,
    hasCashDiscountContext: Boolean(category) || parsed.ambiguous,
    supportedRates: category ? [ratePercent] : [],
    unsupportedRates: [],
    terms
  };
}
function parseCashDiscountTerms(sourceNarration) {
  return parseCashDiscountNarration(sourceNarration).terms;
}
function analyseCashDiscountNarration(input) {
  const sourceNarration = String(input.narration ?? "").trim();
  const parsed = classifyPaymentNarration(sourceNarration);
  const terms = parseCashDiscountTerms(sourceNarration);
  const requirement = parsed.category ? paymentRequirement(parsed.category, input.invoiceDate) : null;
  const receiptDate = validPaymentDate(input.receiptDate);
  const matchedReceiptAmount = input.matchedReceiptAmount != null && Number.isFinite(Number(input.matchedReceiptAmount)) ? asMoney(Number(input.matchedReceiptAmount)) : null;
  const reversalPlan = requirement ? createUnpaidReversalPlan({ terms, invoiceDate: input.invoiceDate, invoiceNetAmount: input.originalAmount, today: input.today }) : null;
  const expectedDiscounts = terms.map((term) => ({ ratePercent: term.ratePercent, amount: asMoney((reversalPlan?.grossInvoiceAmount ?? input.originalAmount) * term.ratePercent / 100) }));
  const base = {
    paymentCategory: parsed.category,
    sourceNarration,
    matchedCashDiscountContext: parseCashDiscountNarration(sourceNarration).matchedCashDiscountContext,
    terms,
    termsLabel: terms.length ? formatCashDiscountTerms(terms) : null,
    finalEligibilityDays: requirement?.eligibilityDays ?? null,
    discountDeadline: requirement?.deadline ?? null,
    receiptDate,
    matchedReceiptAmount,
    expectedDiscounts,
    matchedDiscount: expectedDiscounts.find((term) => moneyClose(input.pendingAmount, term.amount)) ?? null,
    reversalPlan
  };
  const result = (deterministicStatus, deterministicReason) => ({ ...base, deterministicStatus, deterministicReason });
  if (parsed.ambiguous) return result("cash_discount_rate_missing", "Both ADVANCE RTGS and SAME DAY RTGS are present. Review the agreed payment category.");
  if (!parsed.category) return result("no_cash_discount_context", "Neither ADVANCE RTGS nor SAME DAY RTGS was found in the invoice narration.");
  if (!requirement || !validPaymentDate(input.today)) return result("missing_invoice_date", "A valid invoice date and business date are required to check RTGS payment terms.");
  if (input.invoiceEvidenceAmbiguous) return result("receipt_amount_unverified", "Invoice or allocation evidence is ambiguous. Review it in Tally before recovering CD.");
  if (!Number.isFinite(input.originalAmount) || input.originalAmount <= 0 || !Number.isFinite(input.pendingAmount) || input.pendingAmount < 0 || input.pendingAmount > input.originalAmount + 1) {
    return result("receipt_amount_unverified", "The invoice balance cannot be verified. Review it in Tally before recovering CD.");
  }
  if (input.pendingAmount <= 5e-3) {
    if (!receiptDate) return result("receipt_date_not_found", "No linked receipt date proves payment against this invoice.");
    if (matchedReceiptAmount === null || !moneyClose(matchedReceiptAmount, input.originalAmount)) return result("receipt_amount_unverified", "Linked receipts do not prove full payment of this invoice.");
    if (receiptDate <= requirement.deadline) return { ...result("discount_taken_within_window", "Full payment met the agreed RTGS requirement."), reversalPlan: reversalPlan ? { ...reversalPlan, activeDiscount: reversalPlan.initialDiscount, currentPayableAmount: input.originalAmount, totalReversalRequired: 0 } : null };
    return result("late_payment_discount_expired", "Full payment arrived after the RTGS deadline. Recover the category CD separately from the settled invoice.");
  }
  if (input.today <= requirement.deadline) return result("within_eligibility_window", `Payment is required by ${requirement.deadline} (IST).`);
  return result("unpaid_discount_tier_expired", `The ${requirement.category === "advance_rtgs" ? "advance" : "same-day"} payment requirement was missed. Recover the full ${requirement.ratePercent}% category discount and follow up for the remaining Tally balance.`);
}

// apps/api/src/lib/collections.ts
function toText(value, maxLength = 500) {
  if (value === null || value === void 0) return "";
  return String(value).trim().slice(0, maxLength);
}
function toNullableText(value, maxLength = 500) {
  const text = toText(value, maxLength);
  return text || null;
}
function toNumber(value, fallback = 0) {
  const normalized = String(value ?? "").replace(/,/g, "").trim();
  if (!normalized) return fallback;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function getNativeTallyPdfEvidence(snapshot) {
  const candidate = snapshot?.nativeTallyPdf;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const value = candidate;
  const source = toText(value.source, 40);
  const status = toText(value.status, 40);
  const voucherId = toText(value.voucherId, 500);
  const voucherNumber = toText(value.voucherNumber, 500);
  const sha256 = toText(value.sha256, 128);
  if (source !== "tally_voucher_render" || status !== "verified" || !voucherId || !voucherNumber || !sha256) return null;
  return {
    source: "tally_voucher_render",
    status: "verified",
    voucherId,
    voucherNumber,
    reference: toNullableText(value.reference, 500),
    alterId: toNullableText(value.alterId, 500),
    sha256,
    byteSize: toNumber(value.byteSize),
    exportedAt: toText(value.exportedAt, 80)
  };
}
function serializeDebitNoteProposal(row) {
  const nativeTallyPdf = getNativeTallyPdfEvidence(row.customer_snapshot);
  return {
    id: row.id,
    connectionId: row.connection_id,
    companyName: row.company_name,
    financialYear: row.financial_year,
    sourceTransactionId: row.source_transaction_id,
    partyLedgerName: row.party_ledger_name,
    partyGstin: row.party_gstin,
    partyEmail: row.party_email ?? null,
    partyPhone: row.party_phone ?? null,
    partyContactPerson: row.party_contact_person ?? null,
    partyAddress: row.party_address ?? null,
    sourceSalesLedgerName: toNullableText(row.customer_snapshot?.sourceSalesLedgerName, 500),
    linkedInvoiceNumber: row.linked_invoice_number,
    linkedInvoiceDate: row.linked_invoice_date,
    originalInvoiceAmount: row.original_invoice_amount === null ? null : toNumber(row.original_invoice_amount),
    cashDiscountRuleId: row.cash_discount_rule_id,
    cashDiscountRuleName: row.cash_discount_rule_name,
    discountDeadline: row.discount_deadline,
    receiptDate: row.receipt_date,
    amountReceived: row.amount_received === null ? null : toNumber(row.amount_received),
    recoverableAmount: toNumber(row.recoverable_amount),
    reasonCode: row.reason_code,
    narration: row.narration,
    gstMode: row.gst_mode,
    debitNoteDate: row.debit_note_date,
    status: row.status,
    approvalBy: row.approval_by,
    approvedAt: row.approved_at,
    tallyCommandId: row.tally_command_id,
    tallyVoucherGuid: row.tally_voucher_guid,
    tallyVoucherId: row.tally_voucher_id ?? null,
    tallyVoucherNumber: row.tally_voucher_number,
    tallyVoucherDate: row.tally_voucher_date,
    tallyOpenReferenceName: row.tally_open_reference_name ?? null,
    remainingRecoverableAmount: row.remaining_recoverable_amount === null || row.remaining_recoverable_amount === void 0 ? null : toNumber(row.remaining_recoverable_amount),
    createdInTallyAt: row.created_in_tally_at ?? null,
    lastSyncedFromTallyAt: row.last_synced_from_tally_at ?? null,
    communicationStatus: row.communication_status ?? "not_sent",
    communicationChannel: row.communication_channel ?? null,
    communicationRecipient: row.communication_recipient ?? null,
    communicationSentAt: row.communication_sent_at ?? null,
    customerSnapshot: row.customer_snapshot ?? {},
    tallyPdfReference: row.tally_pdf_reference,
    nativeTallyPdf,
    nativeTallyPdfVerified: Boolean(nativeTallyPdf && row.tally_pdf_reference),
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// apps/api/src/lib/payment-follow-up.ts
function isCollectionOnlyPaymentFollowUp(row) {
  return Boolean(row);
}
function validDateText(value) {
  const dateText = String(value ?? "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText)) return null;
  const parsed = Date.parse(`${dateText}T00:00:00.000Z`);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10) === dateText ? dateText : null;
}
function elapsedDays(fromDate, toDate) {
  return Math.floor(
    (Date.parse(`${toDate}T00:00:00.000Z`) - Date.parse(`${fromDate}T00:00:00.000Z`)) / 864e5
  );
}
function derivePaymentFollowUpTiming(bill, today) {
  const currentDate = validDateText(today);
  const dueDate = validDateText(bill.dueDate);
  const invoiceDate = validDateText(bill.invoiceDate);
  if (!currentDate) {
    return {
      eligible: false,
      ageBasis: "missing_dates",
      ageDays: null,
      ageLabel: "Current business date unavailable",
      dueDate,
      invoiceDate
    };
  }
  const requirement = collectionPaymentRequirement(bill.narration, invoiceDate);
  if (requirement) {
    const ageDays = elapsedDays(requirement.deadline, currentDate);
    const shownDays = Math.max(ageDays, 0);
    return {
      eligible: ageDays > 0,
      ageBasis: "due_date",
      ageDays,
      ageLabel: `${shownDays} day${shownDays === 1 ? "" : "s"} overdue`,
      dueDate: requirement.deadline,
      invoiceDate
    };
  }
  return {
    eligible: true,
    ageBasis: "missing_dates",
    ageDays: null,
    ageLabel: "Invoice date or payment terms need review",
    dueDate: null,
    invoiceDate
  };
}
function sortPaymentFollowUpsByPriority(rows) {
  const basisRank = {
    due_date: 1,
    invoice_date: 2,
    missing_dates: 3
  };
  return [...rows].sort((left, right) => {
    const leftRank = basisRank[left.ageBasis];
    const rightRank = basisRank[right.ageBasis];
    if (leftRank !== rightRank) return leftRank - rightRank;
    const ageDifference = (right.ageDays ?? -1) - (left.ageDays ?? -1);
    if (ageDifference !== 0) return ageDifference;
    const amountDifference = right.outstandingAmount - left.outstandingAmount;
    if (amountDifference !== 0) return amountDifference;
    return left.partyLedgerName.localeCompare(right.partyLedgerName);
  });
}

// apps/api/src/lib/collections-dashboard.ts
function normalizeLedgerName(value) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}
function readRawText(raw, key2, maxLength = 500) {
  return toText(raw?.[key2], maxLength) || null;
}
function proposalWithLedgerSnapshot(proposal, ledger) {
  if (!ledger) return proposal;
  const raw = ledger.raw_payload && typeof ledger.raw_payload === "object" ? ledger.raw_payload : {};
  const partyEmail = proposal.party_email ?? readRawText(raw, "email", 320);
  const partyPhone = proposal.party_phone ?? readRawText(raw, "phone", 80);
  const partyContactPerson = proposal.party_contact_person ?? readRawText(raw, "contactPerson", 240);
  const partyAddress = proposal.party_address ?? readRawText(raw, "address", 1e3);
  const partyGstin = proposal.party_gstin ?? ledger.gstin;
  return {
    ...proposal,
    party_gstin: partyGstin,
    party_email: partyEmail,
    party_phone: partyPhone,
    party_contact_person: partyContactPerson,
    party_address: partyAddress,
    customer_snapshot: {
      ...proposal.customer_snapshot ?? {},
      ledgerName: ledger.tally_name,
      parentName: ledger.parent_name,
      gstin: partyGstin,
      email: partyEmail,
      phone: partyPhone,
      contactPerson: partyContactPerson,
      address: partyAddress
    }
  };
}
function proposalIdentityKey(proposal) {
  return [
    normalizeLedgerName(proposal.company_name),
    normalizeLedgerName(proposal.party_ledger_name),
    normalizeLedgerName(proposal.linked_invoice_number),
    toNumber(proposal.recoverable_amount).toFixed(2)
  ].join("|");
}
function proposalRank(proposal) {
  const statusRank = {
    created_in_tally: 60,
    queued_in_tally: 50,
    approved: 40,
    pending_approval: 30,
    draft: 20,
    failed: 10
  };
  const statusScore = statusRank[proposal.status] ?? 0;
  const updatedScore = Date.parse(String(proposal.updated_at ?? proposal.created_at ?? "")) || 0;
  return statusScore * 1e13 + updatedScore;
}
function dedupeDebitNoteProposals(proposals) {
  const bestByKey = /* @__PURE__ */ new Map();
  for (const proposal of proposals) {
    const key2 = proposalIdentityKey(proposal);
    const existing = bestByKey.get(key2);
    if (!existing || proposalRank(proposal) > proposalRank(existing)) {
      bestByKey.set(key2, proposal);
    }
  }
  return Array.from(bestByKey.values()).sort((left, right) => proposalRank(right) - proposalRank(left));
}
function todayText() {
  return businessDateText();
}
function serializeTallyCandidate(params) {
  const originalAmount = toNumber(params.bill.originalAmount);
  const pendingAmount = toNumber(params.bill.pendingAmount);
  const invoiceDate = String(params.bill.invoiceDate ?? "").slice(0, 10);
  const referenceName = toText(params.bill.referenceName ?? params.bill.voucherNumber, 240);
  const raw = params.ledger?.raw_payload && typeof params.ledger.raw_payload === "object" ? params.ledger.raw_payload : {};
  const partyEmail = readRawText(raw, "email", 320);
  const partyPhone = readRawText(raw, "phone", 80);
  const partyContactPerson = readRawText(raw, "contactPerson", 240);
  const partyAddress = readRawText(raw, "address", 1e3);
  const amountReceived = originalAmount > 0 ? Math.max(originalAmount - pendingAmount, 0) : null;
  const isUnpaidTierReversal = isCashDiscountRecoveryStatus(params.analysis.deterministicStatus);
  const stagedReversalAmount = Math.max(
    0,
    toNumber(
      params.stagedReversalAmount ?? params.analysis.reversalPlan?.totalReversalRequired
    )
  );
  const sourceSalesLedgerName = toText(params.bill.sourceSalesLedgerName, 500) || null;
  const expectedDiscount = params.analysis.reversalPlan?.totalReversalRequired ?? stagedReversalAmount;
  const recoverableAmount = stagedReversalAmount;
  const canCreateDebitNote = isCashDiscountRecoveryStatus(params.analysis.deterministicStatus) && recoverableAmount > 0 && Boolean(sourceSalesLedgerName);
  const termsLabel = params.analysis.termsLabel ?? "Narrated cash discount";
  const sourceNarration = params.analysis.sourceNarration;
  const reversalPlan = params.analysis.reversalPlan;
  const referenceSuffix = isUnpaidTierReversal ? `T${reversalPlan?.activeDiscount?.eligibilityDays ?? "FINAL"}` : "SHORT";
  const referenceNumber = `DN-CD-${referenceName || "INVOICE"}-${referenceSuffix}`.slice(0, 120);
  const stagedNarration = reversalPlan ? ` Tally invoice is treated as net after ${reversalPlan.initialDiscount.ratePercent}%: gross basis \u20B9${reversalPlan.grossInvoiceAmount.toLocaleString("en-IN")}; payable now \u20B9${reversalPlan.currentPayableAmount.toLocaleString("en-IN")}; cumulative reversal \u20B9${reversalPlan.totalReversalRequired.toLocaleString("en-IN")}; already created \u20B9${toNumber(params.alreadyCreatedReversalAmount).toLocaleString("en-IN")}.` : "";
  return {
    id: `tally:${Buffer.from(`${params.ledgerName}|${referenceName}|${recoverableAmount.toFixed(2)}|${referenceSuffix}`).toString("base64url")}`,
    connectionId: params.connectionId,
    companyName: params.companyName,
    financialYear: params.financialYear,
    sourceTransactionId: null,
    sourceKind: "tally_open_bill",
    issueType: isUnpaidTierReversal ? "unpaid_discount_tier_reversal" : "discount_shortfall",
    expectedDiscount,
    canCreateDebitNote,
    partyLedgerName: params.ledgerName,
    partyGstin: params.ledger?.gstin ?? null,
    partyEmail,
    partyPhone,
    partyContactPerson,
    partyAddress,
    sourceSalesLedgerName,
    linkedInvoiceNumber: referenceName || params.bill.voucherNumber || null,
    linkedInvoiceDate: invoiceDate || null,
    originalInvoiceAmount: originalAmount || null,
    cashDiscountRuleId: null,
    cashDiscountRuleName: termsLabel,
    discountDeadline: params.analysis.discountDeadline,
    receiptDate: params.analysis.receiptDate,
    receipts: Array.isArray(params.bill.receipts) ? params.bill.receipts : [],
    amountReceived,
    recoverableAmount,
    pendingAmount,
    reasonCode: isUnpaidTierReversal ? "cash_discount_unpaid_tier_reversal" : "cash_discount_narration_expired",
    referenceNumber,
    adjustOriginalInvoice: false,
    narration: `Cash discount recovery against invoice ${referenceName || "-"}. Terms: ${termsLabel}.${stagedNarration} Source narration: ${sourceNarration}`,
    gstMode: "finance_review",
    debitNoteDate: params.today,
    status: "pending_approval",
    approvalBy: null,
    approvedAt: null,
    tallyCommandId: null,
    tallyVoucherGuid: null,
    tallyVoucherId: null,
    tallyVoucherNumber: null,
    tallyVoucherDate: null,
    tallyOpenReferenceName: referenceName || null,
    remainingRecoverableAmount: recoverableAmount,
    cashDiscountAnalysis: {
      sourceNarration,
      matchedCashDiscountContext: params.analysis.matchedCashDiscountContext,
      terms: params.analysis.terms,
      termsLabel,
      finalEligibilityDays: params.analysis.finalEligibilityDays,
      expectedDiscounts: params.analysis.expectedDiscounts,
      reversalPlan,
      receiptDate: params.analysis.receiptDate,
      matchedReceiptAmount: params.analysis.matchedReceiptAmount,
      deterministicStatus: params.analysis.deterministicStatus,
      deterministicReason: params.analysis.deterministicReason,
      calculationVersion: "cash_discount_rtgs_v3"
    },
    createdInTallyAt: null,
    lastSyncedFromTallyAt: null,
    communicationStatus: "not_sent",
    communicationChannel: null,
    communicationRecipient: null,
    communicationSentAt: null,
    customerSnapshot: {
      ledgerName: params.ledger?.tally_name ?? params.ledgerName,
      parentName: params.ledger?.parent_name ?? null,
      gstin: params.ledger?.gstin ?? null,
      email: partyEmail,
      phone: partyPhone,
      contactPerson: partyContactPerson,
      address: partyAddress,
      sourceSalesLedgerName
    },
    tallyPdfReference: null,
    lastError: null,
    createdAt: params.today,
    updatedAt: params.today
  };
}
function serializePaymentFollowUp(params) {
  const originalInvoiceAmount = toNumber(params.bill.originalAmount);
  const outstandingAmount = toNumber(params.bill.pendingAmount);
  const amountReceived = Math.max(originalInvoiceAmount - outstandingAmount, 0);
  const invoiceDate = String(params.bill.invoiceDate ?? "").slice(0, 10) || null;
  const invoiceNumber = toText(params.bill.referenceName ?? params.bill.voucherNumber, 240) || null;
  const timing = derivePaymentFollowUpTiming(params.bill, params.today);
  const raw = params.ledger?.raw_payload ?? {};
  const needsReview = timing.ageBasis === "missing_dates" || params.bill.invoiceEvidenceAmbiguous === true || outstandingAmount > originalInvoiceAmount + 1;
  const followUpStatus = needsReview ? "needs_review" : (timing.ageDays ?? 0) > 30 ? "escalate" : "needs_follow_up";
  return {
    id: "follow-up:" + Buffer.from(params.ledgerName + "|" + (invoiceNumber ?? "-") + "|" + outstandingAmount.toFixed(2)).toString("base64url"),
    kind: needsReview ? "payment_review" : "payment_due",
    followUpStatus,
    paymentCategory: params.analysis.paymentCategory,
    ageBasis: timing.ageBasis,
    ageDays: timing.ageDays,
    ageLabel: timing.ageLabel,
    dueDate: timing.dueDate,
    title: needsReview ? "Invoice evidence needs review" : "Payment pending",
    nextAction: needsReview ? "Confirm invoice dates, terms and allocations in Tally before scheduling reminders." : "Follow up for \u20B9" + outstandingAmount.toLocaleString("en-IN") + ". " + timing.ageLabel + ".",
    partyLedgerName: params.ledgerName,
    partyGstin: params.ledger?.gstin ?? null,
    partyPhone: readRawText(raw, "phone", 80),
    partyEmail: readRawText(raw, "email", 320),
    linkedInvoiceNumber: invoiceNumber,
    linkedInvoiceDate: invoiceDate,
    originalInvoiceAmount,
    outstandingAmount,
    amountReceived,
    lastReceiptDate: params.bill.receiptDate ?? null,
    receipts: Array.isArray(params.bill.receipts) ? params.bill.receipts : [],
    narration: params.analysis.sourceNarration,
    // Collection amounts always describe the remaining Tally balance.
    paymentAmountIfPaidToday: outstandingAmount,
    totalPayableAmount: outstandingAmount,
    currentDiscount: null,
    calculationVersion: "collections_rtgs_v4"
  };
}
function invoiceIdentityKey(partyLedgerName, linkedInvoiceNumber) {
  return [normalizeLedgerName(partyLedgerName), normalizeLedgerName(linkedInvoiceNumber)].join("|");
}

// apps/api/src/lib/cash-discount-live-analysis.ts
function liveCashDiscountLedgerRow(value) {
  const name = toText(value.name, 500);
  if (!name) return null;
  return {
    tally_name: name,
    parent_name: toText(value.parent, 500) || null,
    gstin: toText(value.gstin, 32) || null,
    raw_payload: value.raw && typeof value.raw === "object" ? value.raw : {}
  };
}
function analyseLiveCashDiscountSnapshot(params) {
  const ledgerByName = new Map(params.ledgers.map((ledger) => [normalizeLedgerName(ledger.tally_name), ledger]));
  const createdProposals = params.createdProposals ?? [];
  const createdReversalByInvoice = /* @__PURE__ */ new Map();
  for (const proposal of createdProposals) {
    if (!String(proposal.reason_code || "").startsWith("cash_discount_")) continue;
    const key2 = invoiceIdentityKey(proposal.party_ledger_name, proposal.linked_invoice_number);
    createdReversalByInvoice.set(key2, (createdReversalByInvoice.get(key2) ?? 0) + toNumber(proposal.recoverable_amount));
  }
  const today = todayText();
  const seenBillKeys = /* @__PURE__ */ new Set();
  const narrationReviewRows = [];
  const result = params.openBillsResult?.result && typeof params.openBillsResult.result === "object" ? params.openBillsResult.result : params.openBillsResult;
  const byLedger = result?.byLedger && typeof result.byLedger === "object" ? result.byLedger : {};
  for (const [bucketLedgerName, bucket] of Object.entries(byLedger)) {
    if (bucket.complete === false) continue;
    for (const bill of [...bucket.openBills ?? [], ...bucket.settledBills ?? []]) {
      const ledgerName = toText(bill.ledgerName ?? bucket?.ledgerName ?? bucketLedgerName, 500);
      const billKey = `${normalizeLedgerName(ledgerName)}|${normalizeLedgerName(bill.referenceName)}|${normalizeLedgerName(bill.voucherNumber)}`;
      if (seenBillKeys.has(billKey)) continue;
      seenBillKeys.add(billKey);
      const originalAmount = toNumber(bill.originalAmount);
      const pendingAmount = toNumber(bill.pendingAmount);
      const invoiceDate = String(bill.invoiceDate ?? "").slice(0, 10);
      if (!ledgerName || bill.kind === "advance" || isNonSalesVoucher(bill.sourceVoucherType) || originalAmount <= 0 || pendingAmount < 0) continue;
      narrationReviewRows.push({
        ledgerName,
        bill,
        analysis: analyseCashDiscountNarration({
          narration: bill.narration,
          invoiceDate,
          originalAmount,
          pendingAmount,
          receiptDate: bill.receiptDate,
          matchedReceiptAmount: toNumber(bill.matchedReceiptAmount, Number.NaN),
          invoiceEvidenceAmbiguous: bill.invoiceEvidenceAmbiguous,
          today
        })
      });
    }
  }
  const narratedDiscountRows = narrationReviewRows.filter((row) => row.analysis.terms.length > 0);
  const narrationAnalysis = narrationReviewRows.map((row) => ({
    partyLedgerName: row.ledgerName,
    linkedInvoiceNumber: toText(row.bill.referenceName ?? row.bill.voucherNumber, 240) || null,
    linkedInvoiceDate: String(row.bill.invoiceDate ?? "").slice(0, 10) || null,
    originalInvoiceAmount: toNumber(row.bill.originalAmount),
    pendingAmount: toNumber(row.bill.pendingAmount),
    analysis: {
      paymentCategory: row.analysis.paymentCategory,
      sourceNarration: row.analysis.sourceNarration,
      matchedCashDiscountContext: row.analysis.matchedCashDiscountContext,
      terms: row.analysis.terms,
      termsLabel: row.analysis.termsLabel,
      finalEligibilityDays: row.analysis.finalEligibilityDays,
      discountDeadline: row.analysis.discountDeadline,
      receiptDate: row.analysis.receiptDate,
      matchedReceiptAmount: row.analysis.matchedReceiptAmount,
      expectedDiscounts: row.analysis.expectedDiscounts,
      reversalPlan: row.analysis.reversalPlan,
      deterministicStatus: row.analysis.deterministicStatus,
      deterministicReason: row.analysis.deterministicReason,
      calculationVersion: "collections_rtgs_v4"
    }
  }));
  const paymentFollowUps = sortPaymentFollowUpsByPriority(narrationReviewRows.filter((row) => toNumber(row.bill.pendingAmount) > 5e-3).filter((row) => derivePaymentFollowUpTiming(row.bill, today).eligible).map((row) => serializePaymentFollowUp({
    bill: row.bill,
    ledgerName: row.ledgerName,
    ledger: ledgerByName.get(normalizeLedgerName(row.ledgerName)),
    analysis: row.analysis,
    today,
    createdTierReversalAmount: createdReversalByInvoice.get(
      invoiceIdentityKey(row.ledgerName, toText(row.bill.referenceName ?? row.bill.voucherNumber, 240) || null)
    )
  })).filter(isCollectionOnlyPaymentFollowUp));
  const tallyCandidates = narratedDiscountRows.filter((row) => isCashDiscountRecoveryStatus(row.analysis.deterministicStatus)).map((row) => {
    const invoiceNumber = toText(row.bill.referenceName ?? row.bill.voucherNumber, 240) || null;
    const alreadyCreatedReversalAmount = createdReversalByInvoice.get(invoiceIdentityKey(row.ledgerName, invoiceNumber)) ?? 0;
    const requiredReversalAmount = toNumber(row.analysis.reversalPlan?.totalReversalRequired);
    const stagedReversalAmount = Math.max(0, Math.round((requiredReversalAmount - alreadyCreatedReversalAmount) * 100) / 100);
    if (stagedReversalAmount <= 0.01) return null;
    return serializeTallyCandidate({
      bill: row.bill,
      ledgerName: row.ledgerName,
      ledger: ledgerByName.get(normalizeLedgerName(row.ledgerName)),
      companyName: params.companyName,
      connectionId: params.connectionId,
      financialYear: params.financialYear,
      today,
      analysis: row.analysis,
      stagedReversalAmount,
      alreadyCreatedReversalAmount
    });
  }).filter((candidate) => Boolean(candidate)).sort((left, right) => {
    const leftDate = Date.parse(`${left.linkedInvoiceDate ?? ""}T00:00:00.000Z`) || 0;
    const rightDate = Date.parse(`${right.linkedInvoiceDate ?? ""}T00:00:00.000Z`) || 0;
    return leftDate !== rightDate ? leftDate - rightDate : String(left.partyLedgerName).localeCompare(String(right.partyLedgerName));
  });
  const serializedCreated = createdProposals.map(serializeDebitNoteProposal);
  const proposals = [...tallyCandidates, ...serializedCreated];
  const recoverableAmount = tallyCandidates.reduce((sum, row) => sum + row.recoverableAmount, 0);
  const createdAmount = createdProposals.reduce((sum, row) => sum + toNumber(row.recoverable_amount), 0);
  const paymentFollowUpAmount = paymentFollowUps.reduce((sum, row) => sum + row.outstandingAmount, 0);
  return {
    setupRequired: false,
    preview: params.preview === true,
    company: {
      connectionId: params.connectionId,
      companyName: params.companyName,
      status: params.connectionStatus || "company_loaded",
      lastHeartbeatAt: params.lastHeartbeatAt ?? null,
      tallyReachable: true,
      companyLoaded: true
    },
    filters: { connectionId: params.connectionId, compatibleConnectionIds: [params.connectionId] },
    kpis: {
      totalOutstanding: recoverableAmount,
      overdueOutstanding: null,
      dueThisWeek: null,
      cdAtRisk: null,
      cdExpired: tallyCandidates.length,
      lateShortPayments: narrationReviewRows.filter((row) => ["existing_balance_due", "late_short_payment"].includes(row.analysis.deterministicStatus)).length,
      debitNotesPendingApproval: tallyCandidates.length,
      narratedDiscountInvoices: narratedDiscountRows.length,
      unpaidInvoices: paymentFollowUps.filter((row) => Math.abs(row.outstandingAmount - row.originalInvoiceAmount) <= 1).length,
      partialUnpaidInvoices: paymentFollowUps.filter((row) => row.outstandingAmount < row.originalInvoiceAmount - 1).length,
      paymentFollowUps: paymentFollowUps.length,
      paymentFollowUpAmount,
      needsAttention: tallyCandidates.length,
      createdDebitNotes: createdProposals.length,
      createdDebitNoteAmount: createdAmount
    },
    tabs: {
      overduePayments: [],
      paymentFollowUps,
      cashDiscountTracker: proposals,
      debitNoteQueue: proposals
    },
    narrationAnalysis,
    notes: params.preview ? ["Live Tally results are ready; confirmed debit-note history is being reconciled in the background."] : [
      "Cash-discount terms are calculated from a live Tally response held only in memory.",
      "Debit notes are never created automatically; an eligible result requires a user action and a fresh Tally recheck.",
      "Only confirmed debit notes are saved as the audit trail."
    ]
  };
}

// apps/api/src/lib/cash-discount-live-dashboard.ts
function buildLiveCashDiscountDashboard(params) {
  const { scan, financialYear } = params;
  const openBillsResult = scan.openBillsResult && typeof scan.openBillsResult === "object" ? scan.openBillsResult : null;
  const ledgers = Array.isArray(scan.ledgers) ? scan.ledgers.map(liveCashDiscountLedgerRow).filter((row) => Boolean(row)) : [];
  const ledgerByName = new Map(ledgers.map((ledger) => [normalizeLedgerName(ledger.tally_name), ledger]));
  const createdProposals = dedupeDebitNoteProposals(
    (params.proposalRows ?? []).filter((proposal) => !financialYear || !proposal.financial_year || proposal.financial_year === financialYear).map((proposal) => proposalWithLedgerSnapshot(proposal, ledgerByName.get(normalizeLedgerName(proposal.party_ledger_name))))
  );
  const dashboard = analyseLiveCashDiscountSnapshot({
    connectionId: params.connectionId,
    companyName: params.companyName,
    financialYear,
    openBillsResult: openBillsResult ?? {},
    ledgers,
    createdProposals,
    connectionStatus: params.connectionStatus,
    lastHeartbeatAt: params.lastHeartbeatAt
  });
  return params.followUps ? followUpsDashboard(dashboard) : { ...dashboard, scanSummary: scan.scanSummary ?? null };
}
export {
  buildLiveCashDiscountDashboard,
  resolveScopedLedgers
};
