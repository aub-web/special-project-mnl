// Local dev server: same API as production plus the static files. `npm start`
import express from 'express';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from './api.js';

const root = dirname(fileURLToPath(import.meta.url));
app.use(express.static(join(root, 'public'), { extensions: ['html'] })); // /register → register.html (Netlify does the same)
app.get('*', (req, res) => res.sendFile(join(root, 'public', 'index.html')));

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => console.log(`Studio Project Manila running at http://localhost:${PORT}`));
