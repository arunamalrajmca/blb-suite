/* Shared, named patterns and constants for the BLB Suite extension.
 * Load this file before background.js, content.js, or popup.js.
 * Use factories for RegExp values so stateful flags never leak lastIndex
 * between independent operations.
 */
globalThis.BLBShared = Object.freeze({
  hostnames: Object.freeze({
    blb: 'blueletterbible.org',
    blbWww: 'www.blueletterbible.org',
    blbCom: 'blueletterbible.com',
    blbWwwCom: 'www.blueletterbible.com'
  }),
  urls: Object.freeze({
    blbOrigin: 'https://www.blueletterbible.org',
    blbHome: 'https://www.blueletterbible.org/',
    blbSearch: 'https://www.blueletterbible.org/search/search.cfm'
  }),
  // URL keywords intentionally favor broad suppression on potentially sensitive pages.
  // Keep this list centralized so URL classification can be extended without
  // adding another inline regular expression.
  sensitiveSiteUrlKeywords: Object.freeze([
    'payment', 'hospital', 'healthcare', 'health', 'medicine', 'medical',
    'clinic', 'pharmacy', 'prescription', 'patient', 'diagnosis', 'treatment',
    'doctor', 'medical-record', 'dental', 'surgery', 'therapy', 'laboratory', 'lab',
    'insurance', 'insurer', 'assurance', 'insurance-claim', 'policy', 'policies',
    'claim', 'claims', 'premium', 'beneficiary', 'coverage', 'reimbursement',
    'bank', 'banking', 'banker', 'credit', 'credit-card', 'credit-union', 'loan',
    'mortgage', 'financial', 'finance', 'tax', 'investment', 'trading', 'wallet',
    'billing', 'invoice', 'transaction', 'transfer', 'deposit', 'withdrawal',
    'confidential', 'records', 'account', 'personal-data',
    'attorney', 'lawyer', 'legal', 'court', 'lawsuit'
  ]),
  // Curated domain suffixes cover providers whose hostnames do not reveal
  // their category (for example chase.com). This reviewed seed list is not a
  // complete global directory; expand it only with targeted tests. It is static:
  // no browsing, network requests, or classification work occurs at runtime.
  sensitiveSiteDomainSuffixes: Object.freeze([
    'bank', 'bank.in', 'insurance', 'gov', 'gov.in', 'gov.scot', 'gov.wales',
    'chase.com', 'citi.com', 'bankofamerica.com', 'wellsfargo.com',
    'capitalone.com', 'discover.com', 'americanexpress.com',
    'hdfcbank.com', 'icicibank.com', 'sbi.co.in', 'axisbank.com', 'kotak.com',
    'mychart.com', 'mayoclinic.org', 'clevelandclinic.org', 'hopkinsmedicine.org',
    'massgeneralbrigham.org', 'uclahealth.org', 'kp.org', 'apollohospitals.com',
    'unitedhealthcare.com', 'uhc.com', 'aetna.com', 'cigna.com', 'humana.com',
    'anthem.com', 'bcbs.com', 'geico.com', 'progressive.com', 'statefarm.com',
    'allstate.com', 'licindia.in', 'policybazaar.com', 'healthcare.gov'
  ]),
  isSensitiveSiteHostname(value) {
    let host = String(value || '').trim().toLowerCase().replace(/\.$/, '');
    try {
      if (/^[a-z][a-z\d+.-]*:\/\//i.test(host)) host = new URL(host).hostname.toLowerCase().replace(/\.$/, '');
    } catch (_) {}
    if (host.startsWith('www.')) host = host.slice(4);
    if (!host || host === 'localhost' || /^127(?:\.\d{1,3}){3}$/.test(host)) return false;
    if (this.sensitiveSiteDomainSuffixes.some(domain => host === domain || host.endsWith('.' + domain))) return true;
    if (/(?:^|\.)gov(?:\.[a-z]{2})+$/i.test(host)) return true;
    return /(?:^|[.-])(?:bank|banking|banker|credit.?union|hospital|hospitals|health|healthcare|clinic|medical|patient|mychart|insurance|insurer|assurance|claims)(?:[.-]|$)/i.test(host);
  },
  isSensitiveSiteUrl(value) {
    const raw = String(value || '').trim();
    const normalizedUrl = raw.toLowerCase();
    if (this.sensitiveSiteUrlKeywords.some(keyword => normalizedUrl.includes(keyword))) return true;
    try {
      const url = new URL(raw);
      return (url.protocol === 'http:' || url.protocol === 'https:') && this.isSensitiveSiteHostname(url.hostname);
    } catch (_) {
      return this.isSensitiveSiteHostname(raw);
    }
  },
  regex: Object.freeze({
    // URL and hostname handling
    trailingDot: () => /\.$/,
    leadingWww: () => /^www\./i,
    fileDocumentExtension: () => /\.(?:pdf|html?|xhtml)(?:$|[?#])/i,

    // Text normalization and token boundaries
    whitespace: () => /\s+/g,
    leadingWhitespace: () => /^\s+/,
    trailingWhitespace: () => /\s+$/,
    escapedRegexMeta: () => /[.*+?^${}()|[\]\\]/g,

    // Search syntax
    encodedSpaces: () => /%20/g,
    booleanOperatorWords: () => /\b(?:and|or|not)\b/gi
  })
});
