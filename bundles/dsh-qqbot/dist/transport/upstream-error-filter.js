function normalizeVisibleText(text) {
    return String(text ?? '')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/\s+/g, ' ');
}
export function isRefusalText(text) {
    const value = normalizeVisibleText(text).toLowerCase();
    return value.includes('a language model')
        || value.includes('policies')
        || value.includes('policy')
        || value.includes('guideline');
}
export function isUpstreamAuthError(text) {
    const value = String(text ?? '').trim();
    return /^⚠\s*UNAUTHENTICATED\s*\(code\s+401\):[\s\S]*invalid authentication credentials[\s\S]*OAuth 2 access token/i.test(value);
}
