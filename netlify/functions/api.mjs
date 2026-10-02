// Netlify Function: serves every /api/* request with the same Express app used locally.
import serverless from 'serverless-http';
import { app } from '../../api.js';

// ID / e-signature files are binary; return them base64-encoded so Netlify passes them through intact.
export const handler = serverless(app, { binary: ['image/*', 'application/pdf'] });
