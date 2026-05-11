// AES-GCM helpers for secret storage. Master key supplied via env (SECRETS_MASTER_KEY, base64 32-byte).

async function importMasterKey(masterKeyB64: string) {
	const raw = Uint8Array.from(atob(masterKeyB64), (c) => c.charCodeAt(0));
	return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(plaintext: string, masterKeyB64: string) {
	const key = await importMasterKey(masterKeyB64);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ct = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv },
		key,
		new TextEncoder().encode(plaintext),
	);
	return {
		ciphertext: btoa(String.fromCharCode(...new Uint8Array(ct))),
		iv: btoa(String.fromCharCode(...iv)),
	};
}

export async function decryptSecret(ciphertextB64: string, ivB64: string, masterKeyB64: string) {
	const key = await importMasterKey(masterKeyB64);
	const iv = Uint8Array.from(atob(ivB64), (c) => c.charCodeAt(0));
	const ct = Uint8Array.from(atob(ciphertextB64), (c) => c.charCodeAt(0));
	const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
	return new TextDecoder().decode(pt);
}

// Signed session cookie helpers (HMAC-SHA256).
export async function signCookie(value: string, secret: string) {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
	const b64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
	return `${value}.${b64}`;
}

export async function verifyCookie(signed: string, secret: string) {
	const idx = signed.lastIndexOf(".");
	if (idx < 0) return null;
	const value = signed.slice(0, idx);
	const expected = await signCookie(value, secret);
	// constant-time-ish comparison
	if (expected.length !== signed.length) return null;
	let mismatch = 0;
	for (let i = 0; i < expected.length; i++) {
		mismatch |= expected.charCodeAt(i) ^ signed.charCodeAt(i);
	}
	return mismatch === 0 ? value : null;
}
