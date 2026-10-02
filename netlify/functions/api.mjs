// Netlify Function: serves every /api/* request with the same Express app used locally.
import serverless from 'serverless-http';
import { app } from '../../api.js';

export const handler = serverless(app);
