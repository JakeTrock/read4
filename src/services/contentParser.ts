import { cleanVisualText } from '../utils/textProcessing';
import * as pdfjs from 'pdfjs-dist';
import pdfWorkerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import epubjs from 'epubjs';
import mammoth from 'mammoth';
import MarkdownIt from 'markdown-it';

// Set up PDF.js worker using Vite asset URL
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerSrc;

export type Chapter = string[];
export type BookContent = Chapter[];

export async function extractContent(file: File): Promise<BookContent> {
  const extension = file.name.split('.').pop()?.toLowerCase();

  switch (extension) {
    case 'epub':
      return extractEpub(file);
    case 'pdf':
      return extractPdf(file);
    case 'docx':
      return extractDocx(file);
    case 'md':
      return extractMarkdown(file);
    case 'txt':
    default:
      return extractTxt(file);
  }
}

async function extractEpub(file: File): Promise<BookContent> {
  const arrayBuffer = await file.arrayBuffer();
  const book = epubjs(arrayBuffer);
  await book.ready;

  const chapters: BookContent = [];
  const spine = await (book as any).spine;
  
  // Iterate through spine items
  for (let i = 0; i < spine.length; i++) {
    const item = spine.get(i);
    const doc = await item.load(book.load.bind(book));
    
    // Simple HTML to text extraction
    // In a real implementation, we'd use a more sophisticated parser similar to HTMLtoLines
    const body = doc.body;
    const paragraphs: string[] = [];
    
    // Basic extraction: get all p, div, h1-h6 tags
    const elements = body.querySelectorAll('p, div, h1, h2, h3, h4, h5, h6, li, blockquote');
    elements.forEach((el: any) => {
      const text = el.innerText || el.textContent || '';
      const cleaned = cleanVisualText(text.trim());
      if (cleaned && cleaned.length > 3) {
        paragraphs.push(cleaned);
      }
    });

    if (paragraphs.length > 0) {
      chapters.push(paragraphs);
    }
    
    item.unload();
  }

  return chapters;
}

async function extractPdf(file: File): Promise<BookContent> {
  const arrayBuffer = await file.arrayBuffer();
  const loadingTask = pdfjs.getDocument({ data: arrayBuffer });
  const pdf = await loadingTask.promise;
  
  const allParagraphs: string[] = [];
  
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    
    // Sort items by vertical position (y) then horizontal (x)
    const items = textContent.items as any[];
    items.sort((a, b) => {
      if (Math.abs(a.transform[5] - b.transform[5]) < 5) {
        return a.transform[4] - b.transform[4];
      }
      return b.transform[5] - a.transform[5];
    });

    let pageText = '';
    let lastY = -1;
    
    for (const item of items) {
      if (lastY !== -1 && Math.abs(item.transform[5] - lastY) > 10) {
        pageText += '\n';
      }
      pageText += item.str + ' ';
      lastY = item.transform[5];
    }

    // Basic PDF filtering (simplified version of Python logic)
    const lines = pageText.split('\n');
    for (const line of lines) {
      const cleaned = cleanVisualText(line.trim());
      if (cleaned && cleaned.length > 20) {
        allParagraphs.push(cleaned);
      }
    }
  }

  // Simple chapter detection
  const chapters: BookContent = [];
  let currentChapter: Chapter = [];

  for (const para of allParagraphs) {
    if (para.toLowerCase().includes('chapter') && para.split(' ').length < 10) {
      if (currentChapter.length > 0) {
        chapters.push(currentChapter);
      }
      currentChapter = [para];
    } else {
      currentChapter.push(para);
    }
  }

  if (currentChapter.length > 0) {
    chapters.push(currentChapter);
  }

  return chapters.length > 0 ? chapters : [allParagraphs];
}

async function extractDocx(file: File): Promise<BookContent> {
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  const text = result.value;
  
  const paragraphs = text.split('\n')
    .map(p => cleanVisualText(p.trim()))
    .filter(p => p.length > 3);
    
  return [paragraphs];
}

async function extractMarkdown(file: File): Promise<BookContent> {
  const text = await file.text();
  const md = new MarkdownIt();
  const tokens = md.parse(text, {});
  
  const paragraphs: string[] = [];
  let currentPara = '';
  
  for (const token of tokens) {
    if (token.type === 'inline') {
      currentPara += token.content;
    } else if (token.type === 'paragraph_close' || token.type === 'heading_close') {
      const cleaned = cleanVisualText(currentPara.trim());
      if (cleaned && cleaned.length > 3) {
        paragraphs.push(cleaned);
      }
      currentPara = '';
    }
  }
  
  return [paragraphs];
}

async function extractTxt(file: File): Promise<BookContent> {
  const text = await file.text();
  const paragraphs = text.split(/\n\s*\n/)
    .map(p => cleanVisualText(p.trim()))
    .filter(p => p.length > 3);
    
  if (paragraphs.length <= 1 && text.includes('\n')) {
    return [text.split('\n').map(p => cleanVisualText(p.trim())).filter(p => p.length > 3)];
  }
  
  return [paragraphs];
}
