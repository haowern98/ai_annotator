// This file tells TypeScript that modules loaded via CDN URLs are available.
// It prevents "Cannot find module" errors for these specific URLs.

declare module 'https://cdn.jsdelivr.net/npm/marked@12.0.2/lib/marked.esm.js';
declare module 'https://cdn.jsdelivr.net/npm/dompurify@3.1.5/dist/purify.es.mjs';
