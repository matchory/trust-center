import svelte from 'eslint-plugin-svelte';
import ts from 'typescript-eslint';

export default ts.config(
	{
		ignores: ['.svelte-kit/**', 'build/**', 'src/lib/paraglide/**']
	},
	...ts.configs.recommended,
	...svelte.configs.recommended,
	...svelte.configs.prettier,
	{
		files: ['**/*.svelte', '**/*.svelte.ts'],
		languageOptions: {
			parserOptions: {
				parser: ts.parser,
				extraFileExtensions: ['.svelte']
			}
		},
		rules: {
			// Every page URL is locale-prefixed and built by `localizePath()`.
			// `/de/documents` is not a route id — `reroute` strips the prefix
			// before SvelteKit matches — so `resolve()` cannot express these
			// hrefs. Programmatic navigation is still checked.
			'svelte/no-navigation-without-resolve': ['error', { ignoreLinks: true }]
		}
	}
);
