package dev.mcpfabric.client;

import dev.mcpfabric.McpFabric;
import net.minecraft.client.Minecraft;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ConcurrentLinkedQueue;

/**
 * Work that spans several client ticks (a held key, a held right-click, eating to completion).
 * Tasks are added from handlers and run at the end of every client tick until they report done.
 */
public final class ClientTasks {
	/** One multi-tick job. */
	public interface Task {
		/** Called at the end of each client tick; return true when finished. */
		boolean tick(Minecraft mc);
	}

	private static final ConcurrentLinkedQueue<Task> PENDING = new ConcurrentLinkedQueue<>();
	private static final List<Task> ACTIVE = new ArrayList<>();

	private ClientTasks() {}

	public static void add(Task task) {
		PENDING.add(task);
	}

	/** Run {@code action} after {@code ticks} client ticks (0 = at the end of the current one). */
	public static void later(int ticks, Runnable action) {
		int[] left = {ticks};
		add(mc -> {
			if (left[0]-- > 0) return false;
			action.run();
			return true;
		});
	}

	/** Render thread, end of every client tick. */
	static void tick(Minecraft mc) {
		Task t;
		while ((t = PENDING.poll()) != null) ACTIVE.add(t);
		ACTIVE.removeIf(task -> {
			try {
				return task.tick(mc);
			} catch (Throwable e) {
				McpFabric.LOGGER.error("[mcpfabric] client task failed", e);
				return true;
			}
		});
	}
}
