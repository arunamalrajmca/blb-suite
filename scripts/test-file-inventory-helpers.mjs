export function looksLikeTestFileName(name) {
  const lower = String(name || '').toLowerCase();
  return lower.startsWith('test-') || lower.startsWith('test_') ||
    lower.startsWith('spec-') || lower.startsWith('spec_') ||
    lower.includes('.test.') || lower.includes('.spec.') ||
    lower.includes('test-runner') || lower.includes('spec-runner');
}
