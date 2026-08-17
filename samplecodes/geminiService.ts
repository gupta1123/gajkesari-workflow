
import { GoogleGenAI, Type } from "@google/genai";
import { base64ToGeminiPart } from './pdfService';
import type { ExtractedDocument, Mismatch } from '../types';

const API_KEY = process.env.API_KEY;
if (!API_KEY) {
    throw new Error("API_KEY environment variable not set");
}

const ai = new GoogleGenAI({ apiKey: API_KEY });

const documentExtractionSchema = {
    type: Type.OBJECT,
    properties: {
        documentType: {
            type: Type.STRING,
            description: "The type of the document.",
            enum: [
                "Form 20", "Form 21", "Form 22", "Tax Invoice",
                "Accessories Invoice", "PAN Card", "Aadhaar Card",
                "RTO Slip", "Insurance Policy", "Unknown"
            ]
        },
        fields: {
            type: Type.OBJECT,
            description: "Extracted key-value pairs from the document.",
            properties: {
                chassisNumber: { type: Type.STRING, description: "Vehicle Chassis or VIN." },
                engineNumber: { type: Type.STRING, description: "Vehicle Engine Number." },
                buyerName: { type: Type.STRING, description: "Full name of the buyer/owner." },
                fathersName: { type: Type.STRING, description: "Father's/Spouse's name." },
                panNumber: { type: Type.STRING, description: "PAN number." },
                aadhaarNumber: { type: Type.STRING, description: "Aadhaar number." },
                saleAmount: { type: Type.NUMBER, description: "Total sale amount or invoice value." },
                taxAmount: { type: Type.NUMBER, description: "Motor Vehicle (MV) Tax amount paid." },
                invoiceDate: { type: Type.STRING, description: "Date of the invoice (YYYY-MM-DD)." },
                saleDate: { type: Type.STRING, description: "Date of sale or delivery (YYYY-MM-DD)." },
                policyNumber: { type: Type.STRING, description: "Insurance policy number." },
                policyStartDate: { type: Type.STRING, description: "Insurance policy start date (YYYY-MM-DD)." },
                policyEndDate: { type: Type.STRING, description: "Insurance policy end date (YYYY-MM-DD)." },
                vehicleModel: { type: Type.STRING, description: "The model name of the vehicle." },
                vehicleColor: { type: Type.STRING, description: "The color of the vehicle." },
                permanentAddress: { type: Type.STRING, description: "Permanent address of the buyer." },
                temporaryAddress: { type: Type.STRING, description: "Temporary address of the buyer." },
            }
        }
    },
    required: ["documentType", "fields"],
};


export async function extractDataFromPages(pages: { fileName: string, pageNumber: number, imageData: string }[]): Promise<ExtractedDocument[]> {
    const model = 'gemini-2.5-pro';

    const results: ExtractedDocument[] = [];

    for (const page of pages) {
        try {
            const imagePart = base64ToGeminiPart(page.imageData, 'image/jpeg');
            const response = await ai.models.generateContent({
                model,
                contents: {
                    parts: [
                        imagePart,
                        { text: "Analyze the document image. Identify its type and extract all relevant fields as per the schema. If a field is not present, omit it." }
                    ]
                },
                config: {
                    responseMimeType: 'application/json',
                    responseSchema: documentExtractionSchema,
                }
            });

            const jsonString = response.text.trim();
            const parsed = JSON.parse(jsonString);

            results.push({
                id: `${page.fileName}-p${page.pageNumber}`,
                fileName: page.fileName,
                pageNumber: page.pageNumber,
                documentType: parsed.documentType || 'Unknown',
                fields: parsed.fields || {},
                imageUrl: page.imageData,
            });
        } catch (error) {
            console.error(`Error processing ${page.fileName} page ${page.pageNumber}:`, error);
            // Add a placeholder for the failed page
             results.push({
                id: `${page.fileName}-p${page.pageNumber}`,
                fileName: page.fileName,
                pageNumber: page.pageNumber,
                documentType: 'Processing Error',
                fields: { error: 'Failed to extract data from this page.' },
                imageUrl: page.imageData,
            });
        }
    }
    return results;
}

export async function generateMismatchAnalysis(mismatches: Omit<Mismatch, 'analysis' | 'fixPlan'>[], documents: ExtractedDocument[]): Promise<Mismatch[]> {
    const model = 'gemini-2.5-pro';

    const mismatchAnalysisTasks = mismatches.map(async (mismatch) => {
        const context = mismatch.values.map(v => {
            const doc = documents.find(d => d.id === v.docId);
            return `- In document "${doc?.fileName}" (Type: ${doc?.documentType}), the value is "${v.value}".`;
        }).join('\n');

        const prompt = `
            A data mismatch was found for the field "${mismatch.field}" in a set of vehicle registration documents.
            Context of the mismatch:
            ${context}

            Your task is to provide a risk analysis and a fix plan. Structure your response in two parts using the headings "## Analysis" and "## Fix Plan".
            - **Analysis**: Explain the potential legal and operational risks of this specific mismatch in India (e.g., fines under the MV Act, registration cancellation, insurance claim denial). Be specific.
            - **Fix Plan**: Provide a clear, actionable checklist for the user (e.g., a dealer) to resolve the discrepancy. For example: "Contact the dealer to issue a corrected invoice," or "Prepare an affidavit clarifying the name."
            
            Provide the response in Markdown format.
        `;
        
        try {
            const response = await ai.models.generateContent({
                model: model,
                contents: prompt,
            });

            const markdownText = response.text;
            const analysis = markdownText.split('## Fix Plan')[0].replace('## Analysis', '').trim();
            const fixPlan = markdownText.split('## Fix Plan')[1]?.trim() ?? "No fix plan generated.";
            
            return {
                ...mismatch,
                analysis,
                fixPlan,
            };
        } catch (error) {
            console.error("Error generating mismatch analysis:", error);
            return {
                ...mismatch,
                analysis: "### AI Analysis Failed\nCould not generate a risk analysis for this mismatch.",
                fixPlan: "Please manually review the documents to determine the correct course of action."
            };
        }
    });

    return Promise.all(mismatchAnalysisTasks);
}
