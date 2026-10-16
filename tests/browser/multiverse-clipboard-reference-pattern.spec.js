const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

test.describe('BLB MultiVerse native-copy reference recognition', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../../extension/content.js'),
    'utf8'
  );
  const declaration = source.match(/const referencePattern\s*=\s*\/(.+?)\/([a-z]*);/s);

  test('recognizes compact numbered-book abbreviations and preserves existing formats', () => {
    expect(declaration, 'MultiVerse referencePattern must be present in content.js').not.toBeNull();
    const referencePattern = new RegExp(declaration[1], declaration[2]);

    const samples = [
      ['(1Sa 6:5 KJV)', '1Sa', '6', '5'],
      ['(2Sa 7:23 KJV)', '2Sa', '7', '23'],
      ['(1Ki 9:6 KJV)', '1Ki', '9', '6'],
      ['(2Ki 17:7 KJV)', '2Ki', '17', '7'],
      ['(1Ch 5:25 KJV)', '1Ch', '5', '25'],
      ['(2Ch 7:19 KJV)', '2Ch', '7', '19'],
      ['(2Ki 18:33-35 KJV)', '2Ki', '18', '33'],
      ['(John 3:16 KJV)', 'John', '3', '16'],
      ['(1 Samuel 6:5 KJV)', '1 Samuel', '6', '5'],
      ['(2 Chronicles 7:19 KJV)', '2 Chronicles', '7', '19']
    ];

    for (const [input, expectedBook, expectedChapter, expectedVerse] of samples) {
      referencePattern.lastIndex = 0;
      const match = referencePattern.exec(input);
      expect(match, input).not.toBeNull();
      expect(`${match[1] || ''}${match[2]}`.trim(), input).toBe(expectedBook);
      expect(match[3], input).toBe(expectedChapter);
      expect(match[4], input).toBe(expectedVerse);
    }
  });
});


test.describe('BLB MultiVerse clipboard scope', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../../extension/content.js'),
    'utf8'
  );
  const blockStart = source.indexOf('// ---------- BLB MultiVerse native-copy hyperlink enhancement ----------');
  const blockEnd = source.indexOf('// ---------- BLB Auto Hyperlinker ----------', blockStart);
  const block = source.slice(blockStart, blockEnd);

  test('only enhances copies initiated by BLB native Copy buttons', () => {
    expect(block).toContain('nativeMultiVerseCopyPending = false');
    expect(block).toMatch(/closest\?\.\("#copyButton, #copyByVerseButton"\)/);
    expect(block).toMatch(/if \(!nativeMultiVerseCopyPending\) return;[\s\S]*?e\.preventDefault\(\)/);
    expect(block).toContain('setTimeout(() => { nativeMultiVerseCopyPending = false; }, 0)');
  });
});
