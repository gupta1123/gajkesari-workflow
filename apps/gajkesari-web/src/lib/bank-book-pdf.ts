import { jsPDF } from "jspdf";
import { autoTable } from "jspdf-autotable";
import { buildBankBookRows, type BankBookRow } from "./bank-book-csv";

export function buildBankBookPdf(bank: string, period: string, entries: BankBookRow[], balances?: { opening: number; closing: number }) {
  const rows = buildBankBookRows(bank, period, entries, balances);
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  doc.setProperties({ title: `${bank} Book`, subject: period });
  autoTable(doc, {
    head: [
      [{ content: `${bank} Book`, colSpan: 9, styles: { fontSize: 11 } }],
      [{ content: period, colSpan: 9 }],
      rows[2],
    ],
    body: rows.slice(3),
    theme: "grid",
    margin: { top: 12, right: 12, bottom: 14, left: 12 },
    styles: { font: "helvetica", fontSize: 7, cellPadding: 1.5, lineWidth: 0.15, lineColor: [110, 110, 110], textColor: [20, 20, 20], overflow: "linebreak" },
    headStyles: { fillColor: [255, 255, 255], textColor: [20, 20, 20], fontStyle: "bold" },
    columnStyles: { 0: { cellWidth: 24 }, 1: { cellWidth: 12 }, 2: { cellWidth: 92 }, 3: { cellWidth: 16 }, 4: { cellWidth: 16 }, 5: { cellWidth: 20 }, 6: { cellWidth: 25 }, 7: { halign: "right" }, 8: { halign: "right" } },
    rowPageBreak: "avoid",
    didDrawPage: () => {
      doc.setFontSize(7);
      doc.text(`Page ${doc.getNumberOfPages()}`, 285, 203, { align: "right" });
    },
  });
  return doc.output("blob");
}
