function normalizeVisibleText(text) {
    return String(text ?? '')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/\s+/g, ' ');
}
export function isRefusalText(text) {
    return /\ba\s+language\s+model\b|\bagainst\s+my\s+guidelines?\b/i.test(normalizeVisibleText(text));
}
export function isUpstreamAuthError(text) {
    const value = String(text ?? '').trim();
    return /^⚠\s*UNAUTHENTICATED\s*\(code\s+401\):[\s\S]*invalid authentication credentials[\s\S]*OAuth 2 access token/i.test(value);
}
