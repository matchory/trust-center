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
		}
	}
);
