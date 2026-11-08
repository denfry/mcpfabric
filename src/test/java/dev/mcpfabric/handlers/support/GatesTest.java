package dev.mcpfabric.handlers.support;

import com.google.gson.JsonObject;
import dev.mcpfabric.McpFabric;
import dev.mcpfabric.bridge.RpcException;
import dev.mcpfabric.config.McpConfig;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Field;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * While the player has paused the AI, every action group is refused, not only player control.
 *
 * <p>The gates read the config through {@link McpFabric}, whose logger needs slf4j. NeoForge nodes do
 * not put Minecraft's libraries on the test classpath, so these tests run on the Fabric nodes only;
 * the code under test is shared by both loaders.
 */
class GatesTest {
	private static final boolean SLF4J = present("org.slf4j.Logger");
	private McpConfig config;

	private static boolean present(String className) {
		try {
			Class.forName(className, false, GatesTest.class.getClassLoader());
			return true;
		} catch (ClassNotFoundException e) {
			return false;
		}
	}

	@BeforeEach
	void setUp() throws Exception {
		assumeTrue(SLF4J, "slf4j is not on this node's test classpath");
		config = new McpConfig();
		setConfig(config);
		Takeover.setPaused(false);
	}

	@AfterEach
	void tearDown() throws Exception {
		Takeover.setPaused(false);
		Approvals.onRequest(null);
		if (SLF4J) setConfig(null);
	}

	private static void setConfig(McpConfig cfg) throws Exception {
		Field f = McpFabric.class.getDeclaredField("config");
		f.setAccessible(true);
		f.set(null, cfg);
	}

	private static void assertUnavailable(org.junit.jupiter.api.function.Executable call) {
		RpcException e = assertThrows(RpcException.class, call);
		assertEquals("unavailable", e.code());
	}

	@Test
	void actionGroupsPassWhileTheAiIsActive() {
		assertDoesNotThrow(Gates::commands);
		assertDoesNotThrow(Gates::worldWrite);
		assertDoesNotThrow(Gates::playerControl);
	}

	@Test
	void pausingRefusesCommandsAndWorldWritesToo() {
		Takeover.setPaused(true);
		assertUnavailable(Gates::commands);
		assertUnavailable(Gates::worldWrite);
		assertUnavailable(Gates::playerControl);
		assertUnavailable(Gates::notPaused);
	}

	@Test
	void disabledGroupsAreRefusedWhetherOrNotPaused() {
		config.enableCommands = false;
		config.enableWorldWrite = false;
		assertUnavailable(Gates::commands);
		assertUnavailable(Gates::worldWrite);
	}

	@Test
	void aPausedAiDoesNotAskThePlayerForApproval() {
		config.requireApproval = List.of("command");
		AtomicInteger prompts = new AtomicInteger();
		Approvals.onRequest(p -> prompts.incrementAndGet());
		Takeover.setPaused(true);
		JsonObject params = new JsonObject();
		params.addProperty("command", "time set day");
		assertUnavailable(() -> Approvals.require("command.run", params));
		assertEquals(0, prompts.get());
		assertEquals(0, Approvals.pending().size());
	}
}
