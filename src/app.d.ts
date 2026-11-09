// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
  namespace App {
    interface Error {
      error?: string;
    }
    interface Locals {
      user: {
        id: string;
        email: string;
        first_name: string;
        last_name: string;
        is_operator: boolean;
      } | null;
    }
  }
}

export {};
