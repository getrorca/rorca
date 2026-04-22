import 'express-serve-static-core';

declare global {
  namespace Express {
    interface UserShape {
      id: string;
      email: string;
      supabaseId: string;
      role?: string;
      plan?: string;
    }

    interface Request {
      user?: UserShape;
    }
  }
}

export {};
