package dev.mcpfabric.handlers.support;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.HexFormat;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * Ids that stay the same for one install and one value but do not reveal the value: a keyed hash
 * (HMAC-SHA256). Without the key, even a short value such as a server address cannot be recovered by
 * hashing candidates.
 */
public final class OpaqueIds {
	private OpaqueIds() {}

	/** The first 16 hex digits (64 bits) of HMAC-SHA256(key, value). */
	public static String of(String key, String value) {
		try {
			Mac mac = Mac.getInstance("HmacSHA256");
			mac.init(new SecretKeySpec(key.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
			return HexFormat.of().formatHex(mac.doFinal(value.getBytes(StandardCharsets.UTF_8)), 0, 8);
		} catch (GeneralSecurityException e) {
			throw new IllegalStateException("HmacSHA256 is not available", e);
		}
	}
}
