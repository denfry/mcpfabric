package dev.mcpfabric.bridge;

import com.google.gson.JsonElement;

/** A single RPC method implementation. Returns a JSON result or throws {@link RpcException}. */
@FunctionalInterface
public interface RpcHandler {
	JsonElement handle(RpcContext ctx) throws RpcException;
}
