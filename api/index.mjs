import { createServer } from '../server/index.mjs';

let application;
export default async function handler(req, res) {
  try {
    if (!application) {
      const created = createServer();
      application = created;
      created.ready.catch(() => { if (application === created) application = undefined; });
    }
    const current = application;
    await current.ready;
    await current.requestHandler(req, res);
  } catch {
    // Configuration and database errors may contain provider credentials.
    console.error('Application initialization failed.');
    if (!res.headersSent) {
      res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'Annotated is temporarily unavailable. Please try again shortly.' }));
    } else res.destroy();
  }
}
