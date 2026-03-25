/**
 * Splits a paragraph into sentences, intelligently handling common abbreviations and initials.
 * Ported from lue/content_parser.py
 */
export function splitIntoSentences(paragraph: string): string[] {
    const abbreviations = [
        "Mr", "Mrs", "Ms", "Dr", "Prof", "Rev", "Hon", "Jr", "Sr",
        "Cpl", "Sgt", "Gen", "Col", "Capt", "Lt", "Pvt",
        "vs", "viz", "etc", "eg", "ie",
        "Co", "Inc", "Ltd", "Corp",
        "St", "Ave", "Blvd"
    ];
    
    const abbrevPattern = new RegExp(`\\b(${abbreviations.join('|')})\\.`, 'gi');
    const placeholder = "<READ4_PERIOD>";
    
    // 1. Protect periods in abbreviations
    let processed = paragraph.replace(abbrevPattern, (p1) => `${p1}${placeholder}`);
    
    // 2. Protect periods in initials (e.g., "J. F. Kennedy")
    const initialPattern = /\b([A-Z])\.(?=\s[A-Z])/g;
    processed = processed.replace(initialPattern, `$1${placeholder}`);
    
    // 3. Split the text into sentences
    // JavaScript doesn't support lookbehind as widely or in the same way as Python's re,
    // but modern browsers do. If not, we'd need a different approach.
    // Using a simpler split and then recombining if needed, or using the lookbehind.
    const sentences = processed.split(/(?<=[.!?])\s+/);
    
    // 4. Restore the periods and clean up
    return sentences
        .map(s => s.replace(new RegExp(placeholder, 'g'), '.'))
        .filter(s => s.length > 0);
}

/**
 * Sanitize text for TTS engines
 * Ported from lue/content_parser.py
 */
export function sanitizeTextForTTS(text: string): string {
    if (!text) return "";

    // Remove loose punctuation marks
    let sanitized = text.replace(/(?:^|\s)[.!?]+(?=\s|$)/g, ' ');

    // Replace em and en dash with comma-space
    sanitized = sanitized.replace(/[—–]/g, ', ');
    
    // Replace hyphens between alphanumeric characters with spaces
    sanitized = sanitized.replace(/(?<=\w)-(?=\w)/g, ' ');
    
    // Remove special characters but keep Unicode letters, numbers, and basic punctuation
    sanitized = sanitized.replace(/[^\w\s.,:'-();?!]/gu, '');
    
    // Collapse multiple spaces
    sanitized = sanitized.replace(/\s+/g, ' ');

    return sanitized.trim();
}

/**
 * Clean text for visual display
 * Ported from lue/content_parser.py
 */
export function cleanVisualText(text: string): string {
    if (!text) return "";
    
    if (text.startsWith('__CODE_BLOCK__')) {
        return text.substring(14);
    }
    
    let cleaned = text;

    // 1. Handle spaced dots
    cleaned = cleaned.replace(/\s*\.\s*\.\s*\.\s*(\.\s*)*/g, '...');
    cleaned = cleaned.replace(/\s*\.\s*\.\s*(?!\s*\.)/g, '..');
    cleaned = cleaned.replace(/\.{4,}/g, '...');
    
    // 2. Remove long sequences of repeated non-alphanumeric characters
    cleaned = cleaned.replace(/[-_=~`^]{3,}/g, '');
    cleaned = cleaned.replace(/[*]{4,}/g, '');
    cleaned = cleaned.replace(/[#]{4,}/g, '');
    cleaned = cleaned.replace(/[+]{3,}/g, '');
    cleaned = cleaned.replace(/[|]{3,}/g, '');
    cleaned = cleaned.replace(/[\\]{3,}/g, '');
    cleaned = cleaned.replace(/[/]{3,}/g, '');
    
    // 3. Replace Unicode characters
    const unicodeReplacements: Record<string, string> = {
        '×': ' multiplied by ', '÷': ' divided by ', '±': ' plus or minus ',
        '≤': ' less than or equal to ', '≥': ' greater than or equal to ', '≠': ' not equal to ',
        '≈': ' approximately' , '∞': 'infinity ', '%': ' percent ', '+': ' plus ', '=': ' equals ',
        '°': ' degrees ', '™': ' trademark ', '®': ' registered ',
        '©': ' copyright ', '§': ' section ',
        "’": "'",
        '\u200b': '', '\u200c': '', '\u200d': '',
        '\ufeff': '',
        '\u00ad': '',
    };
    
    for (const [oldChar, newChar] of Object.entries(unicodeReplacements)) {
        cleaned = cleaned.split(oldChar).join(newChar);
    }
    
    // 4. Handle ellipsis
    cleaned = cleaned.replace(/\.{4,}/g, '...');
    cleaned = cleaned.replace(/…+/g, '...');
    
    // 5. Clean up excessive whitespace
    cleaned = cleaned.replace(/\s+/g, ' ');
    
    // 6. Ensure proper spacing around ellipsis
    cleaned = cleaned.replace(/\.\.\.(?=\S)/g, '... ');
    
    // 7. Remove markdown formatting
    cleaned = cleaned.replace(/\*\*([^*]+)\*\*/g, '$1');
    cleaned = cleaned.replace(/\*([^*]+)\*/g, '$1');
    cleaned = cleaned.replace(/__([^_]+)__/g, '$1');
    cleaned = cleaned.replace(/_([^_]+)_/g, '$1');
    cleaned = cleaned.replace(/`([^`]+)`/g, '$1');
    cleaned = cleaned.replace(/~~([^~]+)~~/g, '$1');
    cleaned = cleaned.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    cleaned = cleaned.replace(/\[([^\]]+)\]\[[^ ]*\]/g, '$1');
    cleaned = cleaned.replace(/^\s*\[[^ ]+\]:\s*\S+.*$/gm, '');
    cleaned = cleaned.replace(/^#{1,6}\s+/gm, '');
    
    // 8. Fix common formatting issues
    cleaned = cleaned.replace(/\s+([,!?;:])/g, '$1');
    cleaned = cleaned.replace(/([,!?;:])\s*([,!?;:])/g, '$1 $2');
    
    return cleaned.trim();
}
