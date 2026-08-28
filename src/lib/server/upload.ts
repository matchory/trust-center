export interface UploadedFile {
	filename: string;
	contentType: string;
	bytes: Uint8Array;
}

export class UploadRejected extends Error {}

export interface UploadLimits {
	maxBytes: number;
	allowedTypes: readonly string[];
}

/**
 * Validates one multipart field into bytes. Type and size are checked before
 * anything is read into memory beyond what the platform already buffered, and
 * the filename is reduced to its basename — it is display metadata and a
 * Content-Disposition value, never a path.
 */
export async function readUpload(
	form: FormData,
	field: string,
	limits: UploadLimits
): Promise<UploadedFile> {
	const value = form.get(field);

	if (!(value instanceof File) || value.size === 0) {
		throw new UploadRejected('No file was uploaded.');
	}

	if (value.size > limits.maxBytes) {
		throw new UploadRejected(
			`File is too large: ${value.size} bytes, limit ${limits.maxBytes} bytes.`
		);
	}

	if (!limits.allowedTypes.includes(value.type)) {
		throw new UploadRejected(
			`Unsupported file type "${value.type}". Allowed: ${limits.allowedTypes.join(', ')}.`
		);
	}

	return {
		filename: value.name.split(/[\\/]/).pop() || 'file',
		contentType: value.type,
		bytes: new Uint8Array(await value.arrayBuffer())
	};
}
