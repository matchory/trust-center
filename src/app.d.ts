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
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
