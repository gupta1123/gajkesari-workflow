
import { pdfToImagePages } from './pdfService';
import { extractDataFromPages, generateMismatchAnalysis } from './geminiService';
import { verifyDocuments } from './verificationService';
import type { ExtractedDocument, ProcessingStep } from '../types';

export async function processFiles(
    files: File[], 
    updateStep: (step: ProcessingStep, docs?: ExtractedDocument[]) => void
) {
    // 1. Convert all pages of all PDF files to images
    updateStep('reading_files');
    const allFilePages = await Promise.all(
        files.map(async (file) => {
            const pages = await pdfToImagePages(file);
            return pages.map((page, index) => ({
                fileName: file.name,
                pageNumber: index + 1,
                imageData: page,
            }));
        })
    );
    const flattenedPages = allFilePages.flat();

    // 2. Extract structured data from each image using Gemini
    updateStep('ocr_extraction');
    const extractedDocuments = await extractDataFromPages(flattenedPages);
    updateStep('ocr_extraction', extractedDocuments);


    // 3. Perform deterministic cross-document verification
    updateStep('cross_verification', extractedDocuments);
    const initialMismatches = verifyDocuments(extractedDocuments);

    if (initialMismatches.length === 0) {
        return { finalDocuments: extractedDocuments, mismatchesWithAnalysis: [] };
    }

    // 4. Generate AI-powered analysis and fix plans for mismatches
    updateStep('risk_analysis', extractedDocuments);
    const mismatchesWithAnalysis = await generateMismatchAnalysis(initialMismatches, extractedDocuments);
    
    return { finalDocuments: extractedDocuments, mismatchesWithAnalysis };
}
