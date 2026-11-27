export function looksLikeTestFileName(name) {
  const lower = String(name || '').toLowerCase();
  return lower.startsWith('test-') || lower.startsWith('test_') ||
    lower.startsWith('spec-') || lower.startsWith('spec_') ||
    lower.includes('.test.') || lower.includes('.spec.') ||
    lower.includes('test-runner') || lower.includes('spec-runner');
}

export function extractDeclaredTestTitles(source) {
  const titles = [];
  const declaration = /\b(?:test|it)\s*\(\s*(['"])((?:\\.|[\s\S])*?)\1\s*,/g;
  for (const match of String(source || '').matchAll(declaration)) titles.push(match[2]);
  return titles;
}
