import type { User } from '@cairn/core';

declare global {
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}
