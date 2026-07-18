import type { ExtractedDocument, Mismatch } from '../types';

type FieldValue = {
    value: string | number | null | undefined;
    docId: string;
};

// Simple normalization: lowercase and remove non-alphanumeric chars
const normalize = (str: string | number | null | undefined) => {
    if (typeof str !== 'string') return str?.toString() || null;
    return str.toLowerCase().replace(/[^a-z0-9]/g, '');
};

export function verifyDocuments(documents: ExtractedDocument[]): Omit<Mismatch, 'analysis' | 'fixPlan'>[] {
    const mismatches: Omit<Mismatch, 'analysis' | 'fixPlan'>[] = [];
    const fieldsToVerify = ['chassisNumber', 'engineNumber', 'buyerName', 'panNumber', 'saleAmount'];

    for (const field of fieldsToVerify) {
        const values: FieldValue[] = documents
            .map(doc => ({ value: doc.fields[field], docId: doc.id }))
            .filter(item => item.value !== null && item.value !== undefined && item.value !== '');

        if (values.length < 2) continue; // Not enough data to compare

        const uniqueNormalizedValues = new Set(values.map(v => normalize(v.value)));

        if (uniqueNormalizedValues.size > 1) {
            // Fuzzy match for names to reduce false positives
            if (field === 'buyerName' && uniqueNormalizedValues.size === 2) {
                const vals = Array.from(uniqueNormalizedValues.values());
                // A very basic fuzzy check, could be improved with Levenshtein distance
                if (vals[0]?.includes(vals[1] || '') || vals[1]?.includes(vals[0] || '')) {
                    continue;
                }
            }

            mismatches.push({
                id: `mismatch-${field}-${Date.now()}`, // Add a unique ID
                field,
                values,
            });
        }
    }
    
    // Add more complex checks here in the future, e.g., date logic, tax calculation.

    return mismatches;
}
