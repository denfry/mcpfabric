package dev.mcpfabric.bridge;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * Bridges HTTP worker threads onto the Minecraft main thread.
 *
 * <p>All access to world/entity/player state must happen on the game thread. Both
 * {@code MinecraftServer} and {@code Minecraft} are {@link Executor}s, so handlers schedule work
 * via these helpers and block the (cheap) HTTP worker thread until the result is ready.
 */
public final class MainThread {
	private MainThread() {}

	public static <T> T call(Executor gameThread, long timeoutMs, ThrowingSupplier<T> task) throws RpcException {
		CompletableFuture<T> future = new CompletableFuture<>();
		gameThread.execute(() -> {
			try {
				future.complete(task.get());
			} catch (Throwable t) {
				future.completeExceptionally(t);
			}
		});
		try {
			return future.get(timeoutMs, TimeUnit.MILLISECONDS);
		} catch (TimeoutException e) {
			throw new RpcException("timeout", "The game thread did not complete the action within " + timeoutMs + "ms.");
		} catch (InterruptedException e) {
			Thread.currentThread().interrupt();
			throw new RpcException("interrupted", "Interrupted while waiting for the game thread.");
		} catch (ExecutionException e) {
			Throwable cause = e.getCause() == null ? e : e.getCause();
			if (cause instanceof RpcException rpc) {
				throw rpc;
			}
			throw new RpcException("internal", cause.getClass().getSimpleName() + ": " + cause.getMessage());
		}
	}

	/** Schedule work without waiting for a result. */
	public static void run(Executor gameThread, Runnable task) {
		gameThread.execute(task);
	}
}
