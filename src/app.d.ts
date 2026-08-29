// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		interface Error {
			message: string;
			id?: string;
		}
		interface Locals {
			locale: string;
			/** The locale taken from the URL prefix, or null on an unprefixed path. */
			pathLocale: string | null;
			staff: { id: string; email: string; name: string; role: 'admin' | 'approver' } | null;
			/**
			 * The verified prospect behind the gated subtree. Never populated on a
			 * public path: the cookie carrying it is scoped to `/{locale}/access`.
			 */
			requester: { id: string; email: string; name: string; company: string } | null;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
