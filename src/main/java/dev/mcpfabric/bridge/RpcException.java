package dev.mcpfabric.bridge;

import com.google.gson.JsonElement;
import org.jetbrains.annotations.Nullable;

/**
 * A controlled error returned to the caller as {@code {ok:false, error:{code,message,data}}}.
 * Handlers throw this for expected failure modes (missing param, no server, out of reach, ...).
 */
public class RpcException extends Exception {
	private final String code;
	@Nullable private final JsonElement data;

	public RpcException(String code, String message) {
		this(code, message, null);
	}

	public RpcException(String code, String message, @Nullable JsonElement data) {
		super(message);
		this.code = code;
		this.data = data;
	}

	public String code() {
		return code;
	}

	@Nullable
	public JsonElement data() {
		return data;
	}

	// --- common factory helpers ---------------------------------------------------------------

	public static RpcException badRequest(String message) {
		return new RpcException("bad_request", message);
	}

	public static RpcException notFound(String message) {
		return new RpcException("not_found", message);
	}

	public static RpcException unavailable(String message) {
		return new RpcException("unavailable", message);
	}

	public static RpcException noServer() {
		return new RpcException("no_server", "No server is running (this action requires an integrated or dedicated server).");
	}

	public static RpcException noClientPlayer() {
		return new RpcException("no_client_player", "No local client player is available (this action is client-only and requires being in a world).");
	}
}
