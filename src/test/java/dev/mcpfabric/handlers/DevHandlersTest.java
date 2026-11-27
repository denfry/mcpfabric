package dev.mcpfabric.handlers;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;

class DevHandlersTest {
	private static final List<String> LOG = List.of(
			"\tat a.partial.Line(Earlier.java:1)",
			"[09:00:01] [main/INFO]: Loading 3 mods",
			"[09:00:02] [Server thread/WARN]: Can't keep up!",
			"[09:00:03] [Render thread/ERROR]: Failed to load model",
			"java.lang.IllegalStateException: boom",
			"\tat x.Y.z(Y.java:10)",
			"[27Nov2026 09:00:04.123] [main/INFO] [net.neoforged/]: Done");

	@Test
	void groupsStackTracesWithTheirEntry() {
		List<String> e = DevHandlers.entries(LOG, null, null, 100);
		assertEquals(5, e.size());
		assertEquals("[09:00:03] [Render thread/ERROR]: Failed to load model\njava.lang.IllegalStateException: boom\n\tat x.Y.z(Y.java:10)", e.get(3));
	}

	@Test
	void filtersByLevelAndTextAndKeepsTheNewest() {
		assertEquals(List.of("[09:00:02] [Server thread/WARN]: Can't keep up!", "[09:00:03] [Render thread/ERROR]: Failed to load model\njava.lang.IllegalStateException: boom\n\tat x.Y.z(Y.java:10)"),
				DevHandlers.entries(LOG, "WARN", null, 100));
		assertEquals(List.of("[27Nov2026 09:00:04.123] [main/INFO] [net.neoforged/]: Done"), DevHandlers.entries(LOG, "INFO", null, 1));
		assertEquals(1, DevHandlers.entries(LOG, null, "boom", 100).size());
	}
}
