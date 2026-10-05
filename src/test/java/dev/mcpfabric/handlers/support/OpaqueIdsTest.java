package dev.mcpfabric.handlers.support;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class OpaqueIdsTest {
	@Test
	void stableForOneKeyAndValue() {
		assertEquals(OpaqueIds.of("key", "play.example.net:25565"), OpaqueIds.of("key", "play.example.net:25565"));
	}

	@Test
	void dependsOnTheKeyAndTheValue() {
		assertNotEquals(OpaqueIds.of("key", "127.0.0.1:25565"), OpaqueIds.of("other key", "127.0.0.1:25565"));
		assertNotEquals(OpaqueIds.of("key", "127.0.0.1:25565"), OpaqueIds.of("key", "127.0.0.1:25566"));
	}

	@Test
	void isSixteenHexDigitsWhateverTheValue() {
		for (String value : new String[] {"127.0.0.1:25565", "a.very.long.server.name.example.net:25565", ""}) {
			String id = OpaqueIds.of("key", value);
			assertTrue(id.matches("[0-9a-f]{16}"), id);
		}
	}
}
