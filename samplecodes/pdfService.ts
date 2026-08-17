
/* eslint-disable @typescript-eslint/no-explicit-any */
// This service uses a global pdfjsLib object loaded from a CDN in index.html

declare const pdfjsLib: any;

/**
 * Converts each page of a PDF file into a base64 encoded image URL.
 * @param file The PDF file to process.
 * @returns A promise that resolves to an array of base64 image data URLs.
 */
export async function pdfToImagePages(file: File): Promise<string[]> {
  const fileReader = new FileReader();
  
  return new Promise((resolve, reject) => {
    fileReader.onload = async (event) => {
      if (!event.target?.result) {
        return reject(new Error("Failed to read file"));
      }
      
      try {
        const typedarray = new Uint8Array(event.target.result as ArrayBuffer);
        const pdf = await pdfjsLib.getDocument(typedarray).promise;
        const pageImageUrls: string[] = [];

        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const viewport = page.getViewport({ scale: 1.5 });
          const canvas = document.createElement('canvas');
          const context = canvas.getContext('2d');
          
          if (!context) {
            throw new Error("Could not create canvas context");
          }

          canvas.height = viewport.height;
          canvas.width = viewport.width;

          await page.render({ canvasContext: context, viewport: viewport }).promise;
          
          // Use JPEG for smaller file size
          const imageDataUrl = canvas.toDataURL('image/jpeg', 0.9);
          pageImageUrls.push(imageDataUrl);
        }
        resolve(pageImageUrls);
      } catch (error) {
        reject(error);
      }
    };

    fileReader.onerror = () => {
      reject(new Error("Error reading file"));
    };
    
    fileReader.readAsArrayBuffer(file);
  });
}

/**
 * Converts a base64 string to a format suitable for the Gemini API.
 * @param base64 The base64 data URL (e.g., from canvas.toDataURL).
 * @returns The base64 string without the data URL prefix.
 */
export function base64ToGeminiPart(base64: string, mimeType: 'image/jpeg' | 'image/png') {
  return {
    inlineData: {
      data: base64.split(',')[1],
      mimeType
    }
  };
}
