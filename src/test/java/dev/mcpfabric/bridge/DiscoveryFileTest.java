package dev.mcpfabric.bridge;

import org.junit.jupiter.api.Test;

import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;

class DiscoveryFileTest {
	@Test
	void aConfiguredNameWinsThenTheAccountThenTheGameFolder() {
		Path dir = Path.of("instances", "Survival Pack");
		assertEquals("bot-1", DiscoveryFile.name("  bot-1 ", "Steve", dir));
		assertEquals("Steve", DiscoveryFile.name("", "Steve", dir));
		assertEquals("Survival Pack", DiscoveryFile.name(null, "", dir));
		assertEquals("", DiscoveryFile.name("", "", null));
	}
}
