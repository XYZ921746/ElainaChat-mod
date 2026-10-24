process.env.PORT = process.env.PORT || '4100';
if (!process.env.OPEN_BROWSER) process.env.OPEN_BROWSER = '0';

await import('./web/serve.mjs');
