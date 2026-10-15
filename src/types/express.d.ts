import type { AuthContext } from '../services/authContext.js';

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
      requestId?: string;
    }
  }
}

export {};
