package dev.mcpfabric.bridge;

/** A supplier whose body may throw {@link RpcException} (used with {@link MainThread}). */
@FunctionalInterface
public interface ThrowingSupplier<T> {
	T get() throws RpcException;
}
